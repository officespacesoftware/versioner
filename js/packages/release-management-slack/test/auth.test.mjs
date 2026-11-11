// Node built-in test runner. Run from the package root with:
//   node --test test/auth.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";

import { verifySlackSignature } from "../lib/slack.js";
import { CloudTasksQueue, idTokenVerifier } from "../lib/google.js";

const secret = "signing-secret";
const now = 1_800_000_000_000;
const timestamp = String(now / 1000);
const body = "token=x&payload=%7B%7D";
const signature =
  "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");

test("a request Slack signed is accepted", () => {
  assert.equal(verifySlackSignature(secret, timestamp, signature, body, now), true);
});

test("a changed body, wrong secret or missing header is refused", () => {
  assert.equal(verifySlackSignature(secret, timestamp, signature, body + "x", now), false);
  assert.equal(verifySlackSignature("other", timestamp, signature, body, now), false);
  assert.equal(verifySlackSignature(secret, undefined, signature, body, now), false);
  assert.equal(verifySlackSignature(secret, timestamp, undefined, body, now), false);
});

test("a replayed request older than five minutes is refused", () => {
  assert.equal(
    verifySlackSignature(secret, timestamp, signature, body, now + 301_000),
    false
  );
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const certsFetch = async () => new Response(JSON.stringify({ keys: [jwk] }));

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function idToken(claims, key = privateKey) {
  const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
  const payload = b64(claims);
  const sig = sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), key);
  return `${head}.${payload}.${sig.toString("base64url")}`;
}

const expected = {
  audience: "https://release-manager.example",
  email: "release-manager@p.iam.gserviceaccount.com",
};

const goodClaims = () => ({
  iss: "https://accounts.google.com",
  aud: expected.audience,
  email: expected.email,
  email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 600,
});

test("Cloud Tasks' ID token for our account is accepted", async () => {
  const verify = idTokenVerifier(certsFetch);
  assert.equal(await verify(idToken(goodClaims()), expected), true);
});

test("tokens for another audience or account, expired, or forged are refused", async () => {
  const verify = idTokenVerifier(certsFetch);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

  assert.equal(await verify(idToken({ ...goodClaims(), aud: "https://x" }), expected), false);
  assert.equal(await verify(idToken({ ...goodClaims(), email: "a@b.c" }), expected), false);
  assert.equal(await verify(idToken({ ...goodClaims(), exp: 1 }), expected), false);
  assert.equal(await verify(idToken({ ...goodClaims(), iss: "https://evil" }), expected), false);
  assert.equal(await verify(idToken(goodClaims(), other), expected), false);
  assert.equal(await verify("not.a.token", expected), false);
});

test("a named task that already exists is reported, not created again", async () => {
  const statuses = [200, 409];
  const queue = new CloudTasksQueue(
    { queue: "projects/p/locations/l/queues/q", url: "u", audience: "a", serviceAccount: "s" },
    async () => "token",
    async () => new Response("{}", { status: statuses.shift() })
  );

  assert.equal(await queue.enqueue({}, { name: "apply-x" }), true);
  assert.equal(await queue.enqueue({}, { name: "apply-x" }), false);
});
