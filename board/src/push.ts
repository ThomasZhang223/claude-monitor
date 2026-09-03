/**
 * Web Push to the phone companion, ported from session-monitor's
 * `thomas-zhang/feature/push-notifications` branch (`core/src/push.ts`, 561
 * lines) and adapted for board's own pane addressing and storage location.
 *
 * No `web-push` dependency: a VAPID JWT is P-256 signing and the payload is
 * ECDH + HKDF + AES-128-GCM, all of which `node:crypto` already does, so
 * `core/`'s zero-runtime-dependency property is never at risk — this module
 * lives in `board/`, which already carries its own dependencies.
 *
 * The message body is a Declarative Web Push document (Safari 18.4+): the OS
 * renders it by itself, with no service worker involved. That is the floor
 * this design rests on — `web/sw.js` may replace the notification with a
 * richer one when the phone can reach the laptop, but if the worker never
 * runs, never wakes, or its fetch fails, a correct notification still
 * appears. Unlike original Web Push there is no penalty for a worker that
 * shows nothing, because the declarative message is the documented fallback.
 *
 * What travels is deliberately narrow: the status line and the tmux session
 * name, never a pane's recap, worktree path or branch. RFC 8291 encrypts the
 * body with keys only the device holds, so a push service relays ciphertext
 * it cannot read — but the recap is the one field that quotes a pane's own
 * prose about internal work, and it is exactly the field the service worker
 * can fetch over the user's own tunnel when it matters.
 *
 * Web Push also needs a secure context (HTTPS or `localhost`) to run at all —
 * `PushManager` and `ServiceWorkerContainer` simply do not exist on a page
 * served over plain HTTP to anything but loopback. Since board binds
 * `127.0.0.1` only and has no `--host` flag (see the plan's Settled item 8),
 * a fresh clone with no tunnel in front of it is exactly that case. This
 * module cannot detect or announce that itself — it never sees the page —
 * so `PUSH_INSECURE_CONTEXT_MESSAGE` below is the single source of the
 * explanation text; the client-side check and the control that shows it are
 * the web UI's job (see the corner-cut note beside the constant).
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  buildNotificationContent,
  paneNotifyKey,
  planNotifications,
  NOTIFY_SETTLE_MS,
  type NotifyDecision,
  type NotifyStateMap,
  type NotifyStatus,
  type PaneNotifyState,
  type PlanNotificationsResult,
} from "../../core/src/notify.ts";
import { STATE_DIR, type PaneRecord, type SessionRecord } from "../../core/src/model.ts";

// Re-exported so a caller wiring the sink together needs only this module.
export { planNotifications, type NotifyDecision, type NotifyStateMap, type PaneNotifyState, type PlanNotificationsResult };

const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

// ---------------------------------------------------------------------------
// Storage — moved off session-monitor's path onto board's own, same
// dir-0700 / file-0600 / temp-then-rename discipline as auth.ts's token.
// ---------------------------------------------------------------------------

export const PUSH_DIR = path.join(STATE_DIR, "board", "push");

/**
 * The message board's UI should show in place of the enable-notifications
 * control when the page is not a secure context.
 *
 * ceiling: this module never sees the page, so it cannot itself detect
 * `window.isSecureContext` or render anything — that check and the control it
 * gates belong to board/web/{index.html,app.js,session.js} (the UI panel's
 * files, not this one's). Exporting the string here, rather than letting each
 * caller invent its own wording, is what keeps the eventual client message
 * and this file's own reasoning about the precondition from drifting apart.
 */
export const PUSH_INSECURE_CONTEXT_MESSAGE = "Push needs HTTPS — put a tunnel in front of board.";

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/** RFC 8030's number, which is what Safari looks for to parse a payload
 *  declaratively rather than handing it to a service worker. */
export const DECLARATIVE_WEB_PUSH = 8030;

export interface DeclarativeNotification {
  /** Required, and required non-empty — an empty title makes the whole
   *  payload non-declarative, which fails by silently falling back to
   *  service-worker-only delivery rather than by erroring. */
  title: string;
  body: string;
  /** Required by the spec; navigated to on tap. Points at the web client's
   *  own session detail screen, which is why it carries a fragment. The
   *  window and pane indexes ride along in it because `web/sw.js` is handed
   *  no other context: it is what lets the worker look up the right pane,
   *  and what makes its notification `tag` per-pane instead of per-session. */
  navigate: string;
}

export interface DeclarativePayload {
  web_push: number;
  notification: DeclarativeNotification;
}

/**
 * A browser's push subscription as `pushManager.subscribe()` mints it, plus
 * the origin the page was served from.
 *
 * The origin is stored rather than configured because only the page knows
 * it: board binds loopback and is reached through whichever tunnel the user
 * put in front of it, so the server has no reliable view of its own external
 * name, and inventing configuration for something the client can simply
 * report is a step that can be got wrong.
 */
export interface PushSubscription {
  endpoint: string;
  /** base64url, uncompressed P-256 point (65 octets, leading 0x04). */
  p256dh: string;
  /** base64url, 16 octets. */
  auth: string;
  origin: string;
}

/**
 * Parse and validate one subscription off the wire.
 *
 * Null for anything malformed, so the route answers 400 rather than storing a
 * record that can only fail later at send time, where the failure would look
 * like "push stopped working" instead of "that request was wrong".
 */
export function parseSubscription(body: unknown): PushSubscription | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const keys = typeof raw.keys === "object" && raw.keys !== null ? (raw.keys as Record<string, unknown>) : null;
  const endpoint = raw.endpoint;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  const origin = raw.origin;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (typeof origin !== "string") return null;

  // https only, on both, and parsed rather than pattern-matched: `endpoint`
  // is about to become a request URL and `origin` about to become a tap
  // target.
  let endpointUrl: URL;
  let originUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
    originUrl = new URL(origin);
  } catch {
    return null;
  }
  if (endpointUrl.protocol !== "https:" || originUrl.protocol !== "https:") return null;

  // A P-256 point that is not 65 octets, or an auth secret that is not 16,
  // cannot be from a real subscription and would make the HKDF below derive
  // silently wrong keys instead of failing.
  const pub = fromB64url(p256dh);
  if (pub.length !== 65 || pub[0] !== 0x04) return null;
  if (fromB64url(auth).length !== 16) return null;

  return { endpoint, p256dh, auth, origin: originUrl.origin };
}

/**
 * The declarative payload for one pane's transition.
 *
 * Title and body come straight from `buildNotificationContent` (core's own,
 * shared with the desktop banner) — a second, differently-worded read of the
 * same event is how two surfaces start disagreeing about what happened. Its
 * `message` field, which carries the worktree and the recap, is deliberately
 * not used here.
 *
 * Null when the pane's status is not notify-worthy, which callers looping
 * over `planNotifications`'s fire list will never hit; the check keeps the
 * function honest on its own.
 */
export function buildDeclarativePayload(
  record: SessionRecord,
  pane: PaneRecord,
  origin: string,
): DeclarativePayload | null {
  const content = buildNotificationContent(record, pane);
  if (!content) return null;
  return {
    web_push: DECLARATIVE_WEB_PUSH,
    notification: {
      title: content.title,
      body: content.subtitle,
      navigate:
        `${origin}/#s=${encodeURIComponent(record.tmuxName)}` +
        `&w=${pane.windowIndex}&p=${pane.paneIndex}`,
    },
  };
}

// ---------------------------------------------------------------------------
// VAPID
// ---------------------------------------------------------------------------

export interface VapidKeys {
  /** base64url, uncompressed P-256 point — what the browser wants as
   *  `applicationServerKey`, and what goes in the `k=` authorization field. */
  publicKey: string;
  /** base64url, the raw 32-octet scalar. */
  privateKey: string;
}

/** JWTs are signed per send rather than cached: ES256 over ~100 bytes is
 *  cheaper than the bookkeeping to know when a cached one expired. */
export const VAPID_JWT_TTL_SEC = 12 * 60 * 60;

const VAPID_FILE = "vapid.json";

/** Narrow, defaulted filesystem surface — a test fake is a few lines and
 *  nothing here can reach outside these four operations. */
export interface PushFs {
  readFile(file: string): string;
  writeFile(file: string, data: string, mode: number): void;
  mkdirp(dir: string): void;
  exists(file: string): boolean;
}

/**
 * Same discipline as auth.ts's persistent token: the directory is 0700, a
 * file is written 0600 via a temp-file-then-rename so a reader never sees a
 * half-written secret and the mode is never briefly wider than intended.
 */
export const realPushFs: PushFs = {
  readFile: (file) => fs.readFileSync(file, "utf8"),
  writeFile: (file, data, mode) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode });
    fs.renameSync(tmp, file);
  },
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
  exists: (file) => fs.existsSync(file),
};

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { x: string; y: string; d: string };
  return {
    publicKey: b64url(Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)])),
    privateKey: jwk.d,
  };
}

/**
 * Load the keypair, generating and persisting one on first run.
 *
 * Load-or-create, never regenerate-if-unsure: a new keypair invalidates every
 * subscription already minted against the old public key, and the phone
 * reports that as "push stopped working" with nothing logged anywhere.
 *
 * Lazy by construction: nothing in this module calls this at import time.
 * Whatever wires board's push service together (main.ts) must call it only
 * on first subscribe or first send — a server that never receives a
 * subscription must mint no VAPID keys.
 */
export function loadOrCreateVapidKeys(dir: string = PUSH_DIR, deps: PushFs = realPushFs): VapidKeys {
  const file = path.join(dir, VAPID_FILE);
  if (deps.exists(file)) {
    const parsed = JSON.parse(deps.readFile(file)) as VapidKeys;
    if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") return parsed;
    throw new Error(`${file} exists but is not a VAPID keypair — refusing to overwrite it`);
  }
  const keys = generateVapidKeys();
  deps.mkdirp(dir);
  deps.writeFile(file, JSON.stringify(keys, null, 2), 0o600);
  return keys;
}

function vapidPrivateKeyObject(keys: VapidKeys): crypto.KeyObject {
  const point = fromB64url(keys.publicKey);
  return crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
      d: keys.privateKey,
    },
    format: "jwk",
  });
}

/**
 * A signed VAPID JWT for one endpoint.
 *
 * Two things here are the difference between working and silently not
 * working. The audience is the endpoint's ORIGIN, never the full URL — a full
 * URL is rejected by every push service. And Node's signer emits DER by
 * default while the spec wants a raw 64-octet r||s pair, so
 * `dsaEncoding: "ieee-p1363"` is load-bearing: a DER signature is a perfectly
 * valid signature that is universally refused, which reads as an auth
 * misconfiguration rather than an encoding bug.
 */
export function signVapidJwt(
  endpoint: string,
  subject: string,
  keys: VapidKeys,
  now: number = Date.now(),
): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + VAPID_JWT_TTL_SEC,
        sub: subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), {
    key: vapidPrivateKeyObject(keys),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * The VAPID subject board signs with — RFC 8292 requires a `mailto:` or
 * `https:` contact, checked only for syntax by every push service actually
 * seen in practice, never for deliverability.
 *
 * A fixed placeholder rather than a login-derived address: board has no
 * Calder assumption and no login of its own (Settled item 7), so there is no
 * real identity to put here, and the field carries no decision weight — it
 * never gates or routes anything, it only has to parse as a contact.
 */
export const VAPID_SUBJECT = "mailto:board@localhost";

// ---------------------------------------------------------------------------
// RFC 8291 payload encryption
// ---------------------------------------------------------------------------

/** RFC 8291 section 4: one record, and `rs` must exceed plaintext + delimiter
 *  + tag. 4096 is the payload size a push service must support. */
export const RECORD_SIZE = 4096;

/** The per-message randomness, injected so RFC 8291's own published example
 *  becomes a byte-exact assertion instead of a round trip that only proves
 *  this file agrees with itself. */
export interface PushRandom {
  salt(): Buffer;
  ephemeral(): crypto.ECDH;
}

export const realPushRandom: PushRandom = {
  salt: () => crypto.randomBytes(16),
  ephemeral: () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    return ecdh;
  },
};

/**
 * Encrypt one push message body, per RFC 8291 section 3.4 and RFC 8188.
 *
 *   PRK_key = HKDF-Extract(salt = auth_secret, IKM = ecdh_secret)
 *   IKM     = HKDF-Expand(PRK_key, "WebPush: info" || 0x00 || ua_pub || as_pub, 32)
 *   CEK     = HKDF(salt, IKM, "Content-Encoding: aes128gcm" || 0x00, 16)
 *   NONCE   = HKDF(salt, IKM, "Content-Encoding: nonce" || 0x00, 12)
 *
 * `hkdfSync` does extract-then-expand in one call, which is why the two-step
 * pseudocode above collapses to one line each below. The record sequence
 * number is not exclusive-ORed into the nonce: a push message is a single
 * record and the first record's sequence number is zero.
 */
export function encryptPayload(
  plaintext: Buffer,
  uaPublic: Buffer,
  authSecret: Buffer,
  random: PushRandom = realPushRandom,
): Buffer {
  const salt = random.salt();
  const ecdh = random.ephemeral();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0x00]), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );

  // 0x02 is the last-record padding delimiter; a receiver discards anything
  // else. It follows the plaintext — no padding beyond it, since a push
  // message's length is already visible to the push service either way.
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // RFC 8188 header: salt(16) || rs(4, big-endian) || idlen(1) || keyid.
  // The keyid is the sender's whole uncompressed public point, which is how
  // the receiver knows which key to run ECDH against.
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** A "needs you" from four hours ago is misleading rather than useful, and
 *  the state feed is authoritative anyway — the client recomputes everything
 *  on open and never relies on having been told. */
export const PUSH_TTL_SEC = 300;

/** Mirrors core/src/notify.ts's own status vocabulary. `awaiting` is
 *  `normal` because it is by far the most common transition and a
 *  high-urgency push wakes the radio. */
const URGENCY: Record<NotifyStatus, string> = {
  awaiting: "normal",
  permission: "high",
  error: "high",
  dead: "high",
};

/**
 * The collapse key, hashed rather than used directly.
 *
 * RFC 8030 limits `Topic` to 32 characters of the base64url alphabet, so the
 * natural key `tmuxName:windowIndex.paneIndex` is invalid — it contains a
 * colon and a dot, and is routinely longer. Some services reject that
 * outright, which is recoverable; others ignore the header, which is worse,
 * because notification collapsing quietly stops working and nothing anywhere
 * reports why.
 */
export function topicFor(paneKey: string): string {
  return crypto.createHash("sha256").update(paneKey).digest("base64url").slice(0, 32);
}

export interface PushResponse {
  status: number;
}

/** Just enough of `fetch` to send one message, so tests need no socket. */
export type PushTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer },
) => Promise<PushResponse>;

export const realPushTransport: PushTransport = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  return { status: res.status };
};

export function buildPushHeaders(
  jwt: string,
  vapidPublicKey: string,
  status: NotifyStatus,
  topic: string,
  bodyLength: number,
): Record<string, string> {
  return {
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    "content-length": String(bodyLength),
    ttl: String(PUSH_TTL_SEC),
    urgency: URGENCY[status],
    topic,
    authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
  };
}

/** A subscription is gone only on 404/410. A 400 or 403 is almost always our
 *  own JWT — dropping on those would delete every subscription the first
 *  time a signing bug shipped, turning a code error into data loss. */
export function isGone(status: number): boolean {
  return status === 404 || status === 410;
}

// ---------------------------------------------------------------------------
// Subscription store
// ---------------------------------------------------------------------------

const SUBSCRIPTIONS_FILE = "subscriptions.json";

/**
 * The subscriptions, in memory and on disk, keyed by endpoint.
 *
 * Persisted because a subscription outlives the process: board is restarted
 * routinely during development, and re-subscribing needs a user gesture on
 * the phone, so losing the file means physically picking the phone up again.
 */
export class PushStore {
  private subs = new Map<string, PushSubscription>();

  constructor(
    private readonly dir: string = PUSH_DIR,
    private readonly deps: PushFs = realPushFs,
  ) {
    this.load();
  }

  private get file(): string {
    return path.join(this.dir, SUBSCRIPTIONS_FILE);
  }

  private load(): void {
    if (!this.deps.exists(this.file)) return;
    try {
      const parsed = JSON.parse(this.deps.readFile(this.file)) as unknown[];
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        const sub = parseSubscription({
          endpoint: (entry as PushSubscription)?.endpoint,
          origin: (entry as PushSubscription)?.origin,
          keys: { p256dh: (entry as PushSubscription)?.p256dh, auth: (entry as PushSubscription)?.auth },
        });
        if (sub) this.subs.set(sub.endpoint, sub);
      }
    } catch {
      // A corrupt store must not stop the server starting. The cost is one
      // re-subscribe on the phone, which is recoverable; refusing to boot
      // would take the rest of board down with it, which is the thing that
      // actually matters.
      console.error(`board: ignoring unreadable push store at ${this.file}`);
    }
  }

  private persist(): void {
    this.deps.mkdirp(this.dir);
    this.deps.writeFile(this.file, JSON.stringify([...this.subs.values()], null, 2), 0o600);
  }

  all(): readonly PushSubscription[] {
    return [...this.subs.values()];
  }

  /** Idempotent: re-subscribing the same endpoint replaces its keys rather
   *  than accumulating duplicates that would each get their own buzz. */
  add(sub: PushSubscription): void {
    this.subs.set(sub.endpoint, sub);
    this.persist();
  }

  remove(endpoint: string): void {
    if (this.subs.delete(endpoint)) this.persist();
  }
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

export interface PushDeps {
  transport?: PushTransport;
  random?: PushRandom;
  now?: () => number;
}

/**
 * Everything board needs to push, assembled once (lazily — see
 * `loadOrCreateVapidKeys`) at first use.
 *
 * `notify` has the exact shape of a `NotifySink` below, so it drops into
 * `deliverNotification`'s fan-out with no adapter: one sink's failure — a
 * 410, a dead endpoint — cannot stop the desktop sink firing.
 */
export class PushService {
  constructor(
    private readonly keys: VapidKeys,
    private readonly store: PushStore,
    private readonly subject: string = VAPID_SUBJECT,
    private readonly deps: PushDeps = {},
  ) {}

  publicKey(): string {
    return this.keys.publicKey;
  }

  subscribe(sub: PushSubscription): void {
    this.store.add(sub);
  }

  async notify(record: SessionRecord, pane: PaneRecord): Promise<void> {
    const subs = this.store.all();
    if (subs.length === 0) return;

    const transport = this.deps.transport ?? realPushTransport;
    const random = this.deps.random ?? realPushRandom;
    const now = this.deps.now ?? Date.now;
    const topic = topicFor(paneNotifyKey(record.tmuxName, pane.windowIndex, pane.paneIndex));

    // Independently per subscription, and never rejecting: one phone whose
    // endpoint has expired must not stop another phone being told.
    await Promise.allSettled(
      subs.map(async (sub) => {
        const payload = buildDeclarativePayload(record, pane, sub.origin);
        if (!payload) return;
        const body = encryptPayload(
          Buffer.from(JSON.stringify(payload)),
          fromB64url(sub.p256dh),
          fromB64url(sub.auth),
          random,
        );
        const jwt = signVapidJwt(sub.endpoint, this.subject, this.keys, now());
        const res = await transport(sub.endpoint, {
          method: "POST",
          headers: buildPushHeaders(jwt, this.keys.publicKey, pane.status as NotifyStatus, topic, body.length),
          body,
        });
        if (isGone(res.status)) {
          this.store.remove(sub.endpoint);
          return;
        }
        if (res.status >= 400) {
          console.error(
            `board: push to ${new URL(sub.endpoint).origin} returned ${res.status} ` +
              "— subscription kept, since this is far more often our own JWT than a dead endpoint",
          );
        }
      }),
    );
  }
}

/**
 * Lazily build the push service: keys are minted (or loaded) only here, on
 * first call, never at module load or process start. Whatever wires board's
 * notify sinks together should call this the first time a subscription
 * arrives or a send is attempted, not eagerly at startup — a server that
 * never receives a subscription must mint no VAPID keys.
 */
export function createPushService(deps?: PushDeps): PushService {
  return new PushService(loadOrCreateVapidKeys(), new PushStore(), VAPID_SUBJECT, deps);
}

// ---------------------------------------------------------------------------
// Fan-out — reintroduced here rather than in core/src/notify.ts, since only
// board needs a second sink today and core/ stays at zero runtime
// dependencies. Ported from the same branch's core/src/notify.ts.
// ---------------------------------------------------------------------------

/** Anything that wants to know a pane crossed into a notify-worthy status.
 *  `PushService.notify` and core's `fireNotification` both already have this
 *  exact shape, so each drops in as a sink with zero adapter code.
 *
 * ceiling: the caller passes `planNotifications`'s fire list with no filter,
 * so push fires on all four notify-worthy statuses — including `awaiting`,
 * the most common transition there is. Board's own web UI deliberately
 * excludes `awaiting` from its "Needs you" list on the grounds that it just
 * means "finished, resting" (see the plan's theme table, `NEEDS_USER`). If
 * that proves too noisy in practice, the upgrade path is a status subset
 * filtered off `fire` at the call site — NOT a change to `planNotifications`,
 * which the TUI shares and which would then start withholding desktop
 * banners too.
 */
export type NotifySink = (record: SessionRecord, pane: PaneRecord) => Promise<void>;

/**
 * Deliver one pane's transition to every sink, independently.
 *
 * `Promise.allSettled` is the point: one sink's failure (a push endpoint
 * that 410'd) must never stop another sink from firing.
 */
export async function deliverNotification(
  record: SessionRecord,
  pane: PaneRecord,
  sinks: readonly NotifySink[],
): Promise<void> {
  await Promise.allSettled(sinks.map((sink) => sink(record, pane)));
}

/**
 * Seed a fresh `NotifyStateMap` from the panes as they stand right now,
 * pre-settled and already notified.
 *
 * `planNotifications` treats an absent prior entry as "first sighting of
 * this pane" and resets its settle clock — correct for a pane that is
 * genuinely new, wrong for every pane a freshly (re)started board happens to
 * see first. Without this, restarting board fires one notification per pane
 * already sitting in `awaiting`/`permission`/`error`/`dead` about
 * `NOTIFY_SETTLE_MS` after every start. Call this once, from the very first
 * tick, in place of an empty map; a pane that genuinely transitions
 * afterwards still resets its clock and fires normally through the ordinary
 * path.
 */
export function primeNotifyState(records: readonly SessionRecord[], now: number): NotifyStateMap {
  const state: NotifyStateMap = new Map();
  for (const record of records) {
    for (const pane of record.panes) {
      const key = paneNotifyKey(record.tmuxName, pane.windowIndex, pane.paneIndex);
      state.set(key, { status: pane.status, since: now - NOTIFY_SETTLE_MS, notified: true });
    }
  }
  return state;
}
