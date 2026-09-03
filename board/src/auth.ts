/**
 * Two gates, one mandatory and one optional.
 *
 * The bearer token is the mandatory control: this server hands out a
 * terminal, so an unauthenticated request is a shell. It binds to loopback
 * only (see http.ts's HOST), so the token is what stands between "reachable
 * from this machine" and "reachable by anyone who can reach this machine" —
 * including through whatever tunnel the user puts in front of it (see the
 * plan's Settled item 8: board never learns a tunnel exists).
 *
 * The token is generated once and persisted, so a restart does not invalidate
 * a bookmarked URL. Accepted from a cookie (set from the printed `?t=` link,
 * so the URL is pasteable), an Authorization header (so `curl` and the smoke
 * suite can talk to it), or the `?t=` query directly.
 *
 * Ported from the reference implementation's server/src/auth.ts, moved off that
 * repo's own state directory onto claude-monitor's shared one
 * (core/src/model.ts's STATE_DIR), and with no MONITOR_SERVE_ALLOW: refusing
 * to boot without an allow-list is hostile in a fresh clone (plan Settled
 * item 9).
 *
 * On top of the token, an OPTIONAL identity gate for anyone running an
 * authenticating proxy in front of board (Cloudflare Access, tailscale serve,
 * oauth2-proxy): BOARD_IDENTITY_HEADER names the header the proxy sets,
 * BOARD_IDENTITY_ALLOW the one value it may carry. See resolveIdentityGate.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { STATE_DIR } from "../../core/src/model.ts";

export const COOKIE = "board_token";

/** Kept outside the checkout, like every other piece of board state — a
 *  secret in a git working tree is a secret one `git add -A` away from being
 *  published. */
export const TOKEN_PATH = path.join(STATE_DIR, "board", "token");

export function generateToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * The token, stable across restarts.
 *
 * Regenerating per launch meant every restart invalidated the URL you had
 * open, so no bookmark and no fixed address could ever work. Persisting it
 * costs nothing: it is a local file readable only by you.
 *
 * Written 0600 via a temp file plus rename, so a reader never sees a
 * half-written token and the mode is never briefly wider than intended.
 */
export function persistentToken(file: string = TOKEN_PATH): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* not created yet */
  }
  const token = generateToken();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // An unwritable state directory is not fatal — the token still works for
    // this run, it just will not survive a restart.
  }
  return token;
}

/** Forget the stored token so the next start mints a new one. */
export function rotateToken(file: string = TOKEN_PATH): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to forget */
  }
}

/**
 * Constant-time compare, refusing to ever call it on two empty strings.
 *
 * `crypto.timingSafeEqual` treats two zero-length buffers as equal, so a bug
 * upstream that leaves either side empty (an unset expected value, a header
 * present but blank) must not silently pass. Neither tokenMatches nor
 * identityMatches may ever answer "yes" to "" === "".
 */
function constantTimeEqual(expected: string, given: string): boolean {
  if (expected.length === 0 || given.length === 0) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Constant-time compare, so a token cannot be recovered a byte at a time by
 *  timing the response. */
export function tokenMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  return constantTimeEqual(expected, given);
}

export function tokenFromCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k !== COOKIE) continue;
    try {
      // Malformed percent-encoding (a corrupted or hand-edited cookie) must
      // not crash auth parsing — it just means this cookie carries no
      // usable token, the same as if it were absent.
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

/** Token from an Authorization header, a cookie, or the `?t=` query. */
export function tokenFrom(headers: Record<string, string | string[] | undefined>, url: string): string | null {
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7);
  try {
    // A malformed request URL must not crash auth parsing — fall back to
    // the header/cookie below instead of throwing.
    const query = new URL(url, "http://x").searchParams.get("t");
    if (query) return query;
  } catch {
    /* fall through to the cookie */
  }
  const cookie = headers.cookie;
  return tokenFromCookie(typeof cookie === "string" ? cookie : undefined);
}

/**
 * Reject a cross-origin WebSocket.
 *
 * Cookies ride along on a cross-site WebSocket handshake, so without this a
 * page on any other origin could open a terminal in the background using the
 * victim's own cookie. Same-origin only; a request with no Origin at all (a
 * CLI, the smoke suite) is allowed, since those carry no ambient cookie.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Optional identity gate
// ---------------------------------------------------------------------------

export interface IdentityGate {
  /** The header name a fronting proxy sets, e.g. `Cf-Access-Authenticated-User-Email`. */
  header: string;
  /** The single value that header may carry. */
  allow: string;
}

/**
 * Resolve the optional identity gate from environment, or throw.
 *
 * Three outcomes, by design (see the plan's auth.ts section):
 *  - neither var set: gate is off, the token stands alone. This is the
 *    default and must work in a fresh clone with zero configuration.
 *  - both set: the gate is on.
 *  - exactly one set: a STARTUP error naming the missing one. A half
 *    configured gate that quietly does nothing is the exact failure this
 *    design exists to prevent — never a silent no-op.
 *
 * Throws rather than returning an error value: this is checked once at
 * startup (main.ts), where "fail loud" means the process never binds a port
 * rather than serving with a gate the operator thinks is armed.
 */
export function resolveIdentityGate(
  env: { BOARD_IDENTITY_HEADER?: string; BOARD_IDENTITY_ALLOW?: string },
): IdentityGate | null {
  const header = env.BOARD_IDENTITY_HEADER?.trim();
  const allow = env.BOARD_IDENTITY_ALLOW?.trim();
  if (!header && !allow) return null;
  if (!header) {
    throw new Error(
      "BOARD_IDENTITY_ALLOW is set but BOARD_IDENTITY_HEADER is not — set both, or neither.",
    );
  }
  if (!allow) {
    throw new Error(
      "BOARD_IDENTITY_HEADER is set but BOARD_IDENTITY_ALLOW is not — set both, or neither.",
    );
  }
  return { header, allow };
}

/**
 * Whether a request's identity header satisfies the gate.
 *
 * `gate === null` means the gate is off — every request passes, and the
 * token is the only control. Otherwise an absent header is a denial, never
 * inferred as "local, therefore trusted": the whole point of this gate is
 * that a request can only have reached board through the proxy that sets it.
 */
export function identityMatches(
  gate: IdentityGate | null,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (!gate) return true;
  const raw = headers[gate.header.toLowerCase()];
  const given = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!given) return false;
  return constantTimeEqual(gate.allow, given);
}
