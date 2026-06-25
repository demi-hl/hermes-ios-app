import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOME = process.env.HOME ?? homedir();

// The Anthropic Max/Teams account config dirs to scan, relative to $HOME.
// Set CLAUDE_ACCOUNT_DIRS as a comma-separated list (e.g. ".claude,.claude-work")
// to surface multiple subscriptions; defaults to the single ".claude" dir.
// Dir NAMES can lie about which account they hold, so we read the live
// uuid/email from each and dedupe by uuid. Read-only: never writes creds.
const ACCOUNT_DIRS = (process.env.CLAUDE_ACCOUNT_DIRS ?? ".claude")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

interface Window {
  pct: number | null;
  resetsAt: string | null;
}

interface SubRow {
  label: string;
  email: string | null;
  uuid8: string;
  sub: string | null;
  tier: string | null;
  fiveHour: Window;
  sevenDay: Window;
  hasRefresh: boolean;
  status: "ok" | "rate_limited" | "dead" | "no_token";
}

// Optional display nicknames keyed by account uuid prefix (first 8 chars).
// Set CLAUDE_ACCOUNT_NICKS to a JSON object, e.g. {"<uuid8>":"Main"}, to label
// the cards; otherwise they fall back to the account email or dir name.
function parseNicks(): Record<string, string> {
  try {
    return JSON.parse(process.env.CLAUDE_ACCOUNT_NICKS ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
const NICK_BY_UUID8: Record<string, string> = parseNicks();

// Optional plan override, keyed by uuid prefix. The on-disk `rateLimitTier` /
// `subscriptionType` are a LOGIN-TIME snapshot — they do NOT update on silent
// token refresh, so an account upgraded after its last full login can read
// stale. Set CLAUDE_TIER_OVERRIDE to a JSON object, e.g.
// {"<uuid8>":{"sub":"max","tier":"default_claude_max_20x"}}, to pin the truth;
// everything else falls through to the live token value.
function parseTierOverride(): Record<string, { sub: string; tier: string }> {
  try {
    return JSON.parse(process.env.CLAUDE_TIER_OVERRIDE ?? "{}") as Record<
      string,
      { sub: string; tier: string }
    >;
  } catch {
    return {};
  }
}
const TIER_OVERRIDE: Record<string, { sub: string; tier: string }> = parseTierOverride();

// A non-Anthropic OAuth provider (Codex/ChatGPT, Grok/xAI). These auth via a
// consumer plan that exposes NO usage/limit endpoint, so we surface connection
// HEALTH (live / needs re-auth) and the plan + account — never a fabricated
// burn meter.
interface ConnRow {
  id: string;
  label: string;
  account: string | null;
  plan: string | null;
  status: "live" | "reauth" | "dead" | "no_token";
  detail: string;
  expiresAt: string | null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Decode a JWT payload without verifying — we only read public claims
 *  (plan, email, exp) for display, never trust it for auth. */
function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = Buffer.from(part, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function win(raw: unknown): Window {
  const w = (raw ?? {}) as Record<string, unknown>;
  const u = w.utilization;
  return {
    pct: typeof u === "number" ? Math.round(u) : null,
    resetsAt: typeof w.resets_at === "string" ? w.resets_at : null,
  };
}

async function fetchUsage(token: string): Promise<{
  status: SubRow["status"];
  fiveHour: Window;
  sevenDay: Window;
}> {
  const empty = { pct: null, resetsAt: null };
  if (!token || token.length < 20) {
    return { status: "no_token", fiveHour: empty, sevenDay: empty };
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": OAUTH_BETA },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 429) {
      return { status: "rate_limited", fiveHour: empty, sevenDay: empty };
    }
    if (!res.ok) {
      return { status: "dead", fiveHour: empty, sevenDay: empty };
    }
    const body = (await res.json()) as Record<string, unknown>;
    return {
      status: "ok",
      fiveHour: win(body.five_hour),
      sevenDay: win(body.seven_day),
    };
  } catch {
    return { status: "dead", fiveHour: empty, sevenDay: empty };
  }
}

/** Codex auths via the ChatGPT plan over OAuth (~/.codex/auth.json). The
 *  on-disk access token can read as expired while the refresh token keeps
 *  minting fresh ones on use, so an expired-but-refreshable token is LIVE,
 *  not dead. */
async function codexConn(): Promise<ConnRow | null> {
  const auth = await readJson(join(HOME, ".codex", "auth.json"));
  if (!auth) return null;
  const tokens = (auth.tokens ?? {}) as Record<string, unknown>;
  const access = String(tokens.access_token ?? auth.OPENAI_API_KEY ?? "");
  const idTok = String(tokens.id_token ?? "");
  const hasRefresh = !!tokens.refresh_token;

  const claims = jwtClaims(idTok || access) ?? {};
  const profile = (claims["https://api.openai.com/profile"] ?? {}) as Record<string, unknown>;
  const authClaim = (claims["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const email = (profile.email as string) ?? null;
  const planType = (authClaim.chatgpt_plan_type as string) ?? null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  const expiresAt = exp ? new Date(exp * 1000).toISOString() : null;
  const expired = exp ? exp * 1000 < Date.now() : false;

  let status: ConnRow["status"];
  let detail: string;
  if (!access && !idTok) {
    status = "no_token";
    detail = "no token on this box";
  } else if (!expired) {
    status = "live";
    detail = "token valid";
  } else if (hasRefresh) {
    status = "live";
    detail = "auto-refreshes on use";
  } else {
    status = "dead";
    detail = "token expired, needs re-login";
  }

  return {
    id: "codex",
    label: "Codex",
    account: email,
    plan: planType ? `ChatGPT ${planType}` : "ChatGPT",
    status,
    detail,
    expiresAt,
  };
}

/** Grok auths via xAI OAuth, stored in the grok profile's auth.json. A failed
 *  refresh leaves a `last_auth_error` with `relogin_required`, which we surface
 *  as a re-auth prompt rather than pretending the link is live. */
async function grokConn(): Promise<ConnRow | null> {
  const auth = await readJson(
    join(HOME, ".hermes", "profiles", "grok", "auth.json"),
  );
  if (!auth) return null;
  const providers = (auth.providers ?? {}) as Record<string, unknown>;
  const xai = (providers["xai-oauth"] ?? {}) as Record<string, unknown>;
  if (!xai || Object.keys(xai).length === 0) return null;

  const tokens = (xai.tokens ?? {}) as Record<string, unknown>;
  const hasToken = !!tokens.access_token;
  const lastErr = (xai.last_auth_error ?? null) as Record<string, unknown> | null;
  const reloginRequired = !!lastErr?.relogin_required;

  let status: ConnRow["status"];
  let detail: string;
  if (reloginRequired) {
    status = "reauth";
    detail = "refresh failed, re-login (hermes -p grok auth)";
  } else if (hasToken) {
    status = "live";
    detail = "token valid";
  } else {
    status = "no_token";
    detail = "no token on this box";
  }

  return {
    id: "grok",
    label: "Grok",
    account: null,
    plan: "xAI",
    status,
    detail,
    expiresAt: null,
  };
}

/**
 * All Anthropic Max/Teams subs on this box, each with its 5h-session and
 * 7-day limit utilization (the real subscription limits, distinct from the
 * per-conversation context window meter). Deduped by account uuid so a
 * duplicated config dir does not show as two subs. Plus the non-Anthropic
 * OAuth connections (Codex, Grok) as health rows.
 */
export async function GET() {
  const seen = new Set<string>();
  const subs: SubRow[] = [];

  for (const dir of ACCOUNT_DIRS) {
    const base = join(HOME, dir);
    const profile = await readJson(join(base, ".claude.json"));
    const creds = await readJson(join(base, ".credentials.json"));
    if (!creds) continue;

    const oauth = (creds.claudeAiOauth ?? {}) as Record<string, unknown>;
    const acct = (profile?.oauthAccount ?? {}) as Record<string, unknown>;
    const uuid = String(acct.accountUuid ?? "");
    const uuid8 = uuid.slice(0, 8) || dir;
    if (uuid && seen.has(uuid)) continue; // same account in two dirs
    if (uuid) seen.add(uuid);

    const token = String(oauth.accessToken ?? "");
    const usage = await fetchUsage(token);

    const email = (acct.emailAddress as string) ?? null;
    const ov = TIER_OVERRIDE[uuid8];
    subs.push({
      label: NICK_BY_UUID8[uuid8] ?? email ?? dir,
      email,
      uuid8,
      sub: ov?.sub ?? (oauth.subscriptionType as string) ?? null,
      tier: ov?.tier ?? (oauth.rateLimitTier as string) ?? null,
      fiveHour: usage.fiveHour,
      sevenDay: usage.sevenDay,
      hasRefresh: !!oauth.refreshToken,
      status: usage.status,
    });
  }

  const connections = (
    await Promise.all([codexConn(), grokConn()])
  ).filter((c): c is ConnRow => c !== null);

  return Response.json({ subs, connections, fetchedAt: new Date().toISOString() });
}
