import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  COOKIE,
  generateToken,
  identityMatches,
  originAllowed,
  persistentToken,
  resolveIdentityGate,
  rotateToken,
  tokenFrom,
  tokenFromCookie,
  tokenMatches,
} from "../src/auth.ts";
import { HOST } from "../src/http.ts";

test("generateToken: long, url-safe, and different every time", () => {
  const a = generateToken();
  assert.ok(a.length >= 32);
  assert.match(a, /^[A-Za-z0-9_-]+$/, "safe to put in a URL without encoding");
  assert.notEqual(a, generateToken());
});

test("tokenMatches: exact match only", () => {
  const t = generateToken();
  assert.equal(tokenMatches(t, t), true);
  assert.equal(tokenMatches(t, t.slice(0, -1)), false, "a prefix is not a match");
  assert.equal(tokenMatches(t, t + "x"), false);
  assert.equal(tokenMatches(t, null), false);
  assert.equal(tokenMatches(t, ""), false);
});

test("tokenFromCookie: picks its own cookie out of a crowd", () => {
  assert.equal(tokenFromCookie(`a=1; ${COOKIE}=abc; b=2`), "abc");
  assert.equal(tokenFromCookie("a=1; b=2"), null);
  assert.equal(tokenFromCookie(undefined), null);
});

test("tokenFrom: header beats query beats cookie", () => {
  assert.equal(tokenFrom({ authorization: "Bearer H" }, "/api?t=Q"), "H");
  assert.equal(tokenFrom({ cookie: `${COOKIE}=C` }, "/api?t=Q"), "Q");
  assert.equal(tokenFrom({ cookie: `${COOKIE}=C` }, "/api"), "C");
  assert.equal(tokenFrom({}, "/api"), null);
});

test("originAllowed: rejects a cross-origin websocket handshake", () => {
  // Cookies ride along on a cross-site WS handshake, so without this any page
  // could open a terminal in the background with the victim's own cookie.
  assert.equal(originAllowed("http://evil.test", "localhost:7788"), false);
  assert.equal(originAllowed("http://localhost:7788", "localhost:7788"), true);
  assert.equal(originAllowed("not a url", "localhost:7788"), false);
});

test("originAllowed: no Origin at all is allowed — a CLI carries no cookie", () => {
  assert.equal(originAllowed(undefined, "localhost:7788"), true);
});

test("persistentToken: the same token survives a restart", () => {
  // Regenerating per launch invalidated whatever URL you had open, so no
  // bookmark and no fixed hostname could ever work.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-token-"));
  const file = path.join(dir, "token");
  const first = persistentToken(file);
  assert.ok(first.length >= 32);
  assert.equal(persistentToken(file), first, "a second start reuses it");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("persistentToken: the file is readable only by its owner", () => {
  // It is a shell key. Group- or world-readable is the whole security model
  // gone on a shared machine.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-token-"));
  const file = path.join(dir, "token");
  persistentToken(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("persistentToken: an unwritable location still yields a working token", () => {
  // Degraded, not broken: it works for this run and simply does not persist.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-token-"));
  const blocker = path.join(dir, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  const token = persistentToken(path.join(blocker, "token"));
  assert.ok(token.length >= 32);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotateToken: forgetting it mints a different one next start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "board-token-"));
  const file = path.join(dir, "token");
  const first = persistentToken(file);
  rotateToken(file);
  assert.notEqual(persistentToken(file), first);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("rotateToken: rotating a token that was never stored is not an error", () => {
  rotateToken(path.join(os.tmpdir(), "board-token-does-not-exist", "token"));
});

test("HOST: the server binds loopback and nothing else", () => {
  // A security invariant, not a default: this server hands out a terminal,
  // and remote reach is meant to come from whatever tunnel the user puts in
  // front of it. Pinned so a well-meaning `--host` flag has to argue with a
  // test.
  assert.equal(HOST, "127.0.0.1");
});

// --- the optional identity gate ---------------------------------------------

test("resolveIdentityGate: neither set — the gate is off", () => {
  assert.equal(resolveIdentityGate({}), null);
  assert.equal(resolveIdentityGate({ BOARD_IDENTITY_HEADER: "", BOARD_IDENTITY_ALLOW: "" }), null);
});

test("resolveIdentityGate: both set — the gate is on", () => {
  const gate = resolveIdentityGate({
    BOARD_IDENTITY_HEADER: "Cf-Access-Authenticated-User-Email",
    BOARD_IDENTITY_ALLOW: "me@example.com",
  });
  assert.deepEqual(gate, { header: "Cf-Access-Authenticated-User-Email", allow: "me@example.com" });
});

test("resolveIdentityGate: exactly one set is a startup error, never a silent no-op", () => {
  // A half-configured gate that quietly does nothing is the exact failure
  // this design exists to prevent.
  assert.throws(() => resolveIdentityGate({ BOARD_IDENTITY_HEADER: "X-User" }), /BOARD_IDENTITY_ALLOW/);
  assert.throws(() => resolveIdentityGate({ BOARD_IDENTITY_ALLOW: "me" }), /BOARD_IDENTITY_HEADER/);
});

test("identityMatches: gate off passes everything, token stands alone", () => {
  assert.equal(identityMatches(null, {}), true);
  assert.equal(identityMatches(null, { "x-user": "anyone" }), true);
});

test("identityMatches: the header must match exactly", () => {
  const gate = { header: "X-User", allow: "me@example.com" };
  assert.equal(identityMatches(gate, { "x-user": "me@example.com" }), true);
  assert.equal(identityMatches(gate, { "x-user": "someone-else@example.com" }), false);
});

test("identityMatches: an absent header is a denial, never inferred as trusted", () => {
  const gate = { header: "X-User", allow: "me@example.com" };
  assert.equal(identityMatches(gate, {}), false);
  assert.equal(identityMatches(gate, { "x-other": "me@example.com" }), false);
});

test("identityMatches: header matching is case-insensitive on the name, per HTTP", () => {
  const gate = { header: "X-Custom-Header", allow: "v" };
  assert.equal(identityMatches(gate, { "x-custom-header": "v" }), true);
});
