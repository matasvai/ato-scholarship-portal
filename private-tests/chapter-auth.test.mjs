import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chapterAuthConfigured,
  chairAccountConfigured,
  verifyPassword,
  inviteAccount,
  sendPasswordReset,
  userForAccountToken,
  setPasswordWithToken,
} from "../server/chapter-auth.mjs";

const env = {
  SUPABASE_URL: "https://chapter-test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`,
};
const userId = "d4dc3984-9c89-4ff7-8075-cbe5b2cd18c4";

test("chapter auth requires an exact Supabase origin and two distinct server keys", () => {
  assert.equal(chapterAuthConfigured(env), true);
  assert.equal(chapterAuthConfigured({ ...env, SUPABASE_URL: "http://localhost:54321" }), false);
  assert.equal(chapterAuthConfigured({ ...env, SUPABASE_URL: "https://chapter-test.supabase.co.evil.test" }), false);
  assert.equal(chapterAuthConfigured({ ...env, SUPABASE_PUBLISHABLE_KEY: "" }), false);
  assert.equal(chapterAuthConfigured({ ...env, SUPABASE_SECRET_KEY: env.SUPABASE_PUBLISHABLE_KEY }), false);
});

test("Chair office account requires an exact Auth UUID and email", () => {
  const chair = {
    CHAIR_AUTH_USER_ID: "aab93409-383f-4d8a-b443-3d940a277153",
    CHAIR_ACCOUNT_EMAIL: "chair@example.edu",
  };
  assert.equal(chairAccountConfigured(chair), true);
  assert.equal(chairAccountConfigured({ ...chair, CHAIR_AUTH_USER_ID: "" }), false);
  assert.equal(chairAccountConfigured({ ...chair, CHAIR_ACCOUNT_EMAIL: "" }), false);
});

test("password verification accepts only a confirmed Supabase user", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({
      access_token: "test-access-token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "test-refresh-token",
      user: { id: userId, email: "Member@Example.edu", email_confirmed_at: "2026-09-29T00:00:00Z" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.deepEqual(await verifyPassword(env, "member@example.edu", "a-private-password"),
      { id: userId, email: "member@example.edu" });
    assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=password$/);
    assert.equal(calls[0].options.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
    assert.notEqual(calls[0].options.headers.apikey, env.SUPABASE_SECRET_KEY);
  } finally { globalThis.fetch = previous; }
});

test("chair invitations use the server secret while resets use the publishable key", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(String(url).includes("invite")
      ? { id: userId, email: "member@example.edu" }
      : {}), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.equal(await inviteAccount(env, "member@example.edu", "https://example.edu/account/setup"), userId);
    await sendPasswordReset(env, "member@example.edu", "https://example.edu/account/reset");
    assert.match(calls[0].url, /\/auth\/v1\/invite/);
    assert.equal(calls[0].options.headers.apikey, env.SUPABASE_SECRET_KEY);
    assert.match(calls[1].url, /\/auth\/v1\/recover/);
    assert.equal(calls[1].options.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
  } finally { globalThis.fetch = previous; }
});

test("account link changes a password only for the verified token subject", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ id: userId, email: "member@example.edu" }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.deepEqual(await userForAccountToken(env, "private-test-token"),
      { id: userId, email: "member@example.edu", hasVerifiedFactors: false });
    assert.deepEqual(await setPasswordWithToken(env, "private-test-token", "a-long-new-password", userId),
      { id: userId, email: "member@example.edu" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers.Authorization, "Bearer private-test-token");
  } finally { globalThis.fetch = previous; }
});
