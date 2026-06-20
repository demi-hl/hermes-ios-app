import { NextResponse } from "next/server";
import os from "os";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function storePath() {
  return path.join(os.homedir(), ".hermes", "push-subs.json");
}

/**
 * Send a push notification to all stored subscribers. Accepts
 * { title, body, threadId } and carries threadId in the payload data so the
 * service worker can deep link the notification click to the right thread.
 *
 * web-push is a declared dependency, but if VAPID keys are not configured we
 * return a clear not-configured error rather than throwing.
 */
export async function POST(req: Request) {
  try {
    const { title, body, threadId, tag } = await req.json();

    const pubKey = process.env.VAPID_PUBLIC_KEY || "";
    const privKey = process.env.VAPID_PRIVATE_KEY || "";
    if (!pubKey || !privKey) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "VAPID keys not configured. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in ~/.hermes/.env",
        },
        { status: 503 },
      );
    }

    // web-push is in package.json; guard the import anyway so a missing native
    // build surfaces an honest error instead of a 500 stack.
    let webpush: any;
    try {
      webpush = await import("web-push");
    } catch {
      return NextResponse.json(
        { ok: false, error: "web-push not installed" },
        { status: 503 },
      );
    }

    webpush.setVapidDetails(
      process.env.VAPID_CONTACT ?? "mailto:admin@example.com",
      pubKey,
      privKey,
    );

    const fs = await import("fs/promises");
    const file = storePath();
    let subs: any[] = [];
    try {
      const raw = await fs.readFile(file, "utf-8");
      subs = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { ok: false, error: "No subscribers" },
        { status: 404 },
      );
    }

    // Build a deep link from the threadId so a cold open lands on the thread.
    const url = threadId ? "/?thread=" + encodeURIComponent(threadId) : "/";
    const payload = JSON.stringify({
      title: title || "Hermes",
      body: body || "",
      tag: tag || (threadId ? "thread-" + threadId : "hermes"),
      data: { threadId: threadId || null, url },
    });

    const results = await Promise.allSettled(
      subs.map((sub) => webpush.sendNotification(sub, payload)),
    );
    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    return NextResponse.json({ ok: true, sent, failed });
  } catch (e) {
    console.error("push send error:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
