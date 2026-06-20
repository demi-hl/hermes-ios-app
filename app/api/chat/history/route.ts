import { NextResponse } from "next/server";
import { querySessionByTitle, sessionTitleForBranch } from "@/lib/sessions";
import { readSessionTranscript } from "@/lib/transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Backend-truth transcript for a thread. The iOS app paints from its localStorage
 * cache for instant load, then hydrates from THIS endpoint so the history shown
 * is always the real shared session (replayed from ~/.hermes/state.db), not a
 * per-device copy. A fresh device / cleared phone therefore still shows the full
 * conversation, because the durable history lives on the backend.
 *
 * Query: ?repo=<name|general>&branch=<branch?>  (resolves to the
 * lol-<slug>[__<branch>] session title)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const repo = url.searchParams.get("repo") || "general";
  const branch = url.searchParams.get("branch") || null;
  const title = sessionTitleForBranch(repo, branch);

  try {
    const row = await querySessionByTitle(title);
    if (!row?.id) {
      return NextResponse.json({ messages: [], sessionId: null });
    }
    const messages = await readSessionTranscript(row.id);
    return NextResponse.json({ messages, sessionId: row.id });
  } catch (e) {
    return NextResponse.json(
      { messages: [], sessionId: null, error: e instanceof Error ? e.message : "failed" },
      { status: 200 },
    );
  }
}
