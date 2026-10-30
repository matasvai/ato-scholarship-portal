import { test } from "node:test";
import assert from "node:assert/strict";
import { invitationAccountByEmail, prepareInvitationAccount, sendInvitationAccount, verifyPassword, setPasswordByAdmin } from "../server/chapter-auth.mjs";

const env = {
  SUPABASE_URL: "https://invitation-test.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`,
};
const email = "member@example.edu";
const id = "d4dc3984-9c89-4ff7-8075-cbe5b2cd18c4";
const proof = { version: 1, workspace: "chapter", nonce: "c".repeat(64) };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("provider lookup filters server-side and requires one exact email match", async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  let calls = 0;
  globalThis.fetch = async (input, options) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.pathname, "/auth/v1/admin/users");
    assert.equal(url.searchParams.get("filter"), email);
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("per_page"), "100");
    assert.ok(options.signal);
    assert.equal(options.redirect, "error");
    return reply({ users: [
      { id: "aab93409-383f-4d8a-b443-3d940a277153", email: `other-${email}` },
      { id, email: email.toUpperCase(), email_confirmed_at: "2026-10-01" },
    ] });
  };
  assert.deepEqual(await invitationAccountByEmail(env, email), { id, email, confirmed: true, invitationProof: null });
  assert.equal(calls, 1);
  globalThis.fetch = async () => reply({ users: [{ id, email }, { id, email }] });
  await assert.rejects(invitationAccountByEmail(env, email), /matched safely/);
  globalThis.fetch = async () => reply({ users: Array.from({ length: 100 }, () => ({ id, email: `other-${email}` })) });
  await assert.rejects(invitationAccountByEmail(env, email), /matched safely/);
  globalThis.fetch = async () => reply({ users: [{ id, email: `other-${email}` }] });
  assert.equal(await invitationAccountByEmail(env, email), null);
});

test("account preparation does not confirm email or send mail; unconfirmed and confirmed recipients use correct email flows", async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const calls = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    const body = JSON.parse(options.body);
    calls.push(url.pathname);
    assert.ok(options.signal);
    if (url.pathname === "/auth/v1/admin/users") {
      assert.equal(body.email, email);
      assert.equal(body.email_confirm, false);
      assert.equal(body.password, undefined);
      assert.deepEqual(body.app_metadata, { ato_invitation: proof });
      assert.equal(body.user_metadata, undefined);
      return reply({ id, email, app_metadata: body.app_metadata });
    }
    assert.equal(url.searchParams.get("redirect_to"), "https://portal.example.test/account/setup");
    assert.equal(body.email, email);
    return url.pathname === "/auth/v1/invite" ? reply({ id, email }) : reply({});
  };
  const account = await prepareInvitationAccount(env, email, proof);
  assert.deepEqual(account.invitationProof, proof);
  assert.deepEqual(calls, ["/auth/v1/admin/users"]);
  await sendInvitationAccount(env, account, "https://portal.example.test/account/setup");
  await sendInvitationAccount(env, { ...account, confirmed: true }, "https://portal.example.test/account/setup");
  assert.deepEqual(calls, ["/auth/v1/admin/users", "/auth/v1/invite", "/auth/v1/recover"]);
});

test("only administrator-owned app metadata can supply invitation provenance", async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async () => reply({ users: [{ id, email, user_metadata: { ato_invitation: proof } }] });
  assert.equal((await invitationAccountByEmail(env, email)).invitationProof, null);
  globalThis.fetch = async () => reply({ users: [{ id, email, app_metadata: { ato_invitation: proof } }] });
  assert.deepEqual((await invitationAccountByEmail(env, email)).invitationProof, proof);
});

test("unexpected invited user id is treated as an ambiguous send, never rebound", async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async () => reply({ id: "aab93409-383f-4d8a-b443-3d940a277153", email });
  await assert.rejects(sendInvitationAccount(env, { id, email, confirmed: false }, "https://portal.example.test/account/setup"), /could not be confirmed/);
});

test("only a recognized Auth429 is a proven email rejection; other provider failures remain ambiguous", async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const account = { id, email, confirmed: false };
  for (const code of ["over_email_send_rate_limit", "over_request_rate_limit"]) {
    globalThis.fetch = async () => reply({ error_code: code, msg: "Private provider diagnostic" }, 429);
    await assert.rejects(sendInvitationAccount(env, account, "https://portal.example.test/account/setup"), error =>
      error.status === 429 && error.emailNotAccepted === true && /one hour/.test(error.message) && !error.message.includes("Private"));
  }
  for (const [status, code] of [[503, "over_email_send_rate_limit"], [500, "smtp_error"], [429, "unexpected_code"], [400, "over_email_send_rate_limit"]]) {
    globalThis.fetch = async () => reply({ error_code: code, msg: "Private provider diagnostic" }, status);
    await assert.rejects(sendInvitationAccount(env, account, "https://portal.example.test/account/setup"), error =>
      error.emailNotAccepted === undefined && error.status === undefined && /could not be confirmed/.test(error.message));
  }
});

test("ordinary password verification and updates also receive a bounded provider signal", async t => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const signals = [];
  globalThis.fetch = async (input, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    signals.push(options.signal);
    const user = { id, email, email_confirmed_at: "2026-10-01" };
    return new URL(String(input)).pathname === "/auth/v1/token"
      ? reply({ user, access_token: "test-only", refresh_token: "test-only", expires_in: 3600, token_type: "bearer" })
      : reply(user);
  };
  assert.deepEqual(await verifyPassword(env, email, "fictional-password"), { id, email });
  assert.equal(await setPasswordByAdmin(env, id, "new-fictional-password"), id);
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});
