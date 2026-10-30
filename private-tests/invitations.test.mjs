import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../server/database.mjs";
import { runInvitation, invitationView, invitationList } from "../server/invitations.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "ato-invitation-"));
  const storage = await openDatabase({ env: {}, directory });
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  let clock = Date.parse("2026-10-10T12:00:00Z");
  let writeFailure;
  const db = { ...storage, prepare(sql) {
    const original = storage.prepare(sql);
    return { ...original, run: (...args) => {
      if (writeFailure?.(sql, args)) { writeFailure = null; throw Error("injected database interruption"); }
      return original.run(...args);
    } };
  } };
  const accounts = new Map();
  const calls = { creates: 0, sends: 0, finds: 0 };
  const input = { name: "Fictional Member", email: "member@example.edu", badge: "1234", tier: 2, credits: 15 };
  const provider = {
    async find(email) { calls.finds++; return accounts.get(email) || null; },
    async create(email, invitationProof) {
      calls.creates++;
      if (accounts.has(email)) throw Error("duplicate provider account");
      const account = { id: randomUUID(), email, confirmed: false, invitationProof };
      accounts.set(email, account);
      return account;
    },
    async send(account) {
      calls.sends++;
      const member = await storage.prepare("SELECT id FROM members WHERE email=?").get(account.email);
      assert.ok(member, "member must be committed before email can be sent");
      assert.equal((await storage.prepare("SELECT member_id FROM identities WHERE provider='supabase' AND subject=?").get(account.id))?.member_id, member.id);
    },
  };
  const run = (action = "create", extras = {}) => runInvitation({
    db, workspace: "chapter", email: input.email, input, action,
    authorize: async () => {}, guard: async () => {}, provider, now: () => clock, ...extras,
  });
  const state = async () => JSON.parse((await storage.prepare("SELECT data FROM chapters WHERE workspace='chapter'").get()).data);
  const setState = value => storage.prepare("UPDATE chapters SET data=? WHERE workspace='chapter'").run(JSON.stringify(value));
  return { db, storage, provider, input, accounts, calls, run, state, setState,
    advance: ms => { clock += ms; },
    failWrite: callback => { writeFailure = callback; },
    clock: () => clock,
  };
}

test("invitation commits member and aliases before email; retries preserve tier and send exactly once", async t => {
  const f = await fixture(t);
  await f.setState({ submissions: [], tierAssignments: { [f.input.email]: 4 } });
  const result = await f.run();
  assert.equal(result.invitation.status, "sent");
  assert.match(result.invitation.loginId, /^KH-[A-F0-9]{10}$/);
  assert.equal((await f.storage.prepare("SELECT tier FROM members WHERE id=?").get(result.memberId)).tier, 4);
  assert.equal((await f.state()).tierAssignments[f.input.email], undefined);
  assert.equal(JSON.stringify(result).includes(f.accounts.get(f.input.email).id), false, "provider identity is private");
  assert.equal(JSON.stringify(result).includes((await f.state()).invitations[f.input.email].provenance), false, "provisioning proof is private");
  const retry = await f.run("create", { input: { ...f.input, tier: 1, credits: 0 } });
  assert.equal(retry.memberId, result.memberId);
  assert.equal(f.calls.creates, 1);
  assert.equal(f.calls.sends, 1);
  assert.equal((await f.storage.prepare("SELECT COUNT(*) AS count FROM members").get()).count, 1);
  assert.equal((await f.storage.prepare("SELECT COUNT(*) AS count FROM identities").get()).count, 3);
  await assert.rejects(f.run("resend"), error => error.status === 429);
  f.advance(60_001);
  await f.run("resend");
  assert.equal(f.calls.sends, 2);
  assert.equal(f.calls.creates, 1);
});

test("prepare creates one durable account without email and only explicit send crosses the mail boundary", async t => {
  const f = await fixture(t);
  const prepared = await f.run("prepare");
  assert.equal(prepared.invitation.status, "ready");
  assert.equal(prepared.invitation.canResend, true);
  assert.equal(prepared.invitation.canSendInitial, true);
  assert.equal(f.calls.sends, 0);
  assert.equal((await f.run("prepare")).memberId, prepared.memberId);
  assert.equal((await f.run("create")).memberId, prepared.memberId, "legacy create cannot accidentally email a saved account");
  assert.equal((await f.run("reconcile")).memberId, prepared.memberId);
  assert.equal(f.calls.creates, 1);
  assert.equal(f.calls.sends, 0);
  await f.run("resend");
  assert.equal(f.calls.sends, 1);
  await f.storage.prepare("UPDATE members SET active=0 WHERE id=?").run(prepared.memberId);
  await assert.rejects(f.run("prepare"), error => error.status === 409);
});

test("initial-email eligibility excludes prior attempts, uncertain results, and busy or unprepared accounts", () => {
  const ready = { email: "member@example.edu", name: "Member", bound: true, status: "ready" };
  assert.equal(invitationView(ready, 100).canSendInitial, true);
  for (const changes of [
    { bound: false }, { initialEmailEligible: false }, { status: "sent" }, { status: "delivery_unknown" },
    { status: "failed" }, { status: "preparing" }, { status: "sending" },
    { lastAttemptAt: "2026-10-01T00:00:00Z" }, { lastSentAt: "2026-10-01T00:00:00Z" },
    { operation: { until: 101 } }, { retryAt: 101 },
  ]) assert.equal(invitationView({ ...ready, ...changes }, 100).canSendInitial, false, JSON.stringify(changes));
});

test("initial send requires a prepared account and replays cannot send another email", async t => {
  const f = await fixture(t);
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  assert.deepEqual(f.calls, { creates: 0, sends: 0, finds: 0 });
  const prepared = await f.run("prepare");
  assert.equal(prepared.invitation.canSendInitial, true);
  const sent = await f.run("send-initial");
  assert.equal(sent.invitation.status, "sent");
  assert.equal(sent.invitation.canSendInitial, false);
  assert.equal(f.calls.sends, 1);
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  f.advance(60_001);
  await f.run("reconcile");
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  assert.equal(f.calls.sends, 1);
  assert.equal(f.calls.creates, 1);
});

test("concurrent initial email and explicit resend cannot cross the same send boundary twice", async t => {
  const f = await fixture(t);
  await f.run("prepare");
  const find = f.provider.find;
  let release, started;
  const reached = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.provider.find = async email => { started(); await gate; return find(email); };
  const first = f.run("send-initial");
  await reached;
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  await assert.rejects(f.run("resend"), error => error.status === 409);
  release();
  await first;
  assert.equal(f.calls.sends, 1);
});

test("an uncertain initial send stays excluded even after reconciliation and cooldown", async t => {
  const f = await fixture(t);
  await f.run("prepare");
  const send = f.provider.send;
  f.provider.send = async account => { await send(account); throw Error("accepted, response lost"); };
  await assert.rejects(f.run("send-initial"), error => error.status === 503);
  assert.equal((await f.state()).invitations[f.input.email].status, "delivery_unknown");
  f.advance(90_001);
  const checked = await f.run("reconcile");
  assert.equal(checked.invitation.canSendInitial, false);
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  assert.equal(f.calls.sends, 1);
});

test("a proven email-limit rejection permits only a later manually selected retry", async t => {
  const f = await fixture(t);
  await f.run("prepare");
  let attempts = 0;
  const send = f.provider.send;
  f.provider.send = async () => {
    attempts++;
    throw Object.assign(Error("email limit"), { status: 429, emailNotAccepted: true });
  };
  await assert.rejects(f.run("send-initial"), error => error.status === 429);
  const rejected = (await f.state()).invitations[f.input.email];
  assert.equal(rejected.status, "ready");
  assert.ok(rejected.lastAttemptAt);
  assert.equal(rejected.lastSendRejected, "rate_limit");
  assert.equal(invitationView(rejected, f.clock()).canSendInitial, false);
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  f.advance(60 * 60_000 + 1);
  assert.equal(invitationView((await f.state()).invitations[f.input.email], f.clock()).canSendInitial, true);
  assert.equal(attempts, 1, "cooldown expiry never automatically sends");
  f.provider.send = send;
  await f.run("send-initial");
  assert.equal(f.calls.sends, 1);
  assert.equal((await f.state()).invitations[f.input.email].lastSendRejected, undefined);
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
});

test("a failure during a retry cannot retain the earlier known-rejection exemption", async t => {
  const f = await fixture(t);
  await f.run("prepare");
  f.provider.send = async () => { throw Object.assign(Error("email limit"), { status: 429, emailNotAccepted: true }); };
  await assert.rejects(f.run("send-initial"), error => error.status === 429);
  f.advance(60 * 60_000 + 1);
  f.provider.send = async () => { throw Error("mail response lost"); };
  await assert.rejects(f.run("send-initial"), error => error.status === 503);
  const record = (await f.state()).invitations[f.input.email];
  assert.equal(record.status, "delivery_unknown");
  assert.equal(record.lastSendRejected, undefined);
  f.advance(60 * 60_000 + 1);
  assert.equal(invitationView(record, f.clock()).canSendInitial, false);
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
});

test("a rejected resend does not erase an earlier accepted invitation or enable bulk recovery", async t => {
  const f = await fixture(t);
  const accepted = await f.run("create");
  f.advance(60_001);
  f.provider.send = async () => { throw Object.assign(Error("email limit"), { status: 429, emailNotAccepted: true }); };
  await assert.rejects(f.run("resend"), error => error.status === 429);
  f.advance(60 * 60_000 + 1);
  const view = invitationView((await f.state()).invitations[f.input.email], f.clock());
  assert.equal(view.status, "sent");
  assert.equal(view.lastSentAt, accepted.invitation.lastSentAt);
  assert.equal(view.canSendInitial, false);
  assert.equal(view.canResend, true);
  assert.match(view.message, /declined/);
});

test("an uncertain send followed by a rejected resend never regains first-send eligibility", async t => {
  const f = await fixture(t);
  await f.run("prepare");
  const send = f.provider.send;
  f.provider.send = async account => { await send(account); throw Error("mail response lost"); };
  await assert.rejects(f.run("send-initial"), error => error.status === 503);
  assert.equal((await f.state()).invitations[f.input.email].initialEmailEligible, false);
  f.advance(60_001);
  f.provider.send = async () => { throw Object.assign(Error("email limit"), { status: 429, emailNotAccepted: true }); };
  await assert.rejects(f.run("resend"), error => error.status === 429);
  f.advance(60 * 60_000 + 1);
  const reconciled = await f.run("reconcile");
  assert.equal(reconciled.invitation.status, "delivery_unknown");
  assert.equal(reconciled.invitation.canSendInitial, false);
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  assert.equal(f.calls.sends, 1);
});

test("initial send rechecks membership and authorization before contacting the mail provider", async t => {
  const f = await fixture(t);
  const prepared = await f.run("prepare");
  await assert.rejects(f.run("send-initial", { guard: () => { throw Object.assign(Error("roster changed"), { status: 409 }); } }), error => error.status === 409);
  await assert.rejects(f.run("send-initial", { authorize: () => { throw Object.assign(Error("session ended"), { status: 401 }); } }), error => error.status === 401);
  await assert.rejects(f.run("send-initial", {
    audit: async action => {
      if (action === "roster.invitation_reconcile") await f.storage.prepare("UPDATE members SET active=0 WHERE id=?").run(prepared.memberId);
    },
  }), error => error.status === 409);
  assert.equal(f.calls.sends, 0);
});

test("confirmed or newly confirmed accounts cannot receive a recovery email through bulk initial send", async t => {
  const f = await fixture(t);
  const prepared = await f.run("prepare");
  f.accounts.get(f.input.email).confirmed = true;
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  assert.equal(invitationView((await f.state()).invitations[f.input.email], f.clock()).canSendInitial, false);
  assert.equal((await f.run("reconcile")).invitation.canSendInitial, false);
  const state = await f.state();
  delete state.invitations;
  await f.setState(state);
  const legacy = await f.run("reconcile");
  assert.equal(legacy.memberId, prepared.memberId);
  assert.equal(legacy.invitation.canSendInitial, false);
  await assert.rejects(f.run("send-initial"), error => error.status === 409);
  assert.equal(f.calls.sends, 0);
  await f.run("resend");
  assert.equal(f.calls.sends, 1, "individual reviewed resends remain available");
});

test("prepare recovery after an interrupted provider response never sends email", async t => {
  const f = await fixture(t), create = f.provider.create;
  f.provider.create = async (email, proof) => { await create(email, proof); throw Error("lost response"); };
  await assert.rejects(f.run("prepare"), error => error.status === 503);
  const resumed = await f.run("prepare");
  assert.equal(resumed.invitation.status, "ready");
  assert.equal(f.calls.creates, 1);
  assert.equal(f.calls.sends, 0);
});

test("reconciling an untracked member preserves its portal ID and editable badge", async t => {
  const f = await fixture(t);
  const memberId = randomUUID(), authId = randomUUID(), alias = "kh-abcdef1234";
  await f.storage.prepare("INSERT INTO members(workspace,id,name,email,role,tier,credits,active) VALUES (?,?,?,?,?,?,?,1)")
    .run("chapter", memberId, f.input.name, f.input.email, "member", 2, 15);
  for (const [provider, subject] of [["supabase", authId], ["login", "1234"], ["login", alias]])
    await f.storage.prepare("INSERT INTO identities VALUES (?,?,?,?)").run("chapter", provider, subject, memberId);
  f.accounts.set(f.input.email, { id: authId, email: f.input.email, confirmed: true });

  const result = await f.run("reconcile");
  assert.equal(result.invitation.loginId, alias.toUpperCase());
  assert.equal((await f.state()).invitations[f.input.email].badge, "1234");
  assert.equal((await f.run("prepare")).invitation.loginId, alias.toUpperCase());
  assert.deepEqual((await f.storage.prepare("SELECT subject FROM identities WHERE provider='login' ORDER BY subject").all()).map(row => row.subject), ["1234", alias]);
  assert.equal(f.calls.creates, 0);
  assert.equal(f.calls.sends, 0);
});

test("provider create timeout repairs the exact account without sending or duplicating it", async t => {
  const f = await fixture(t);
  const create = f.provider.create;
  f.provider.create = async (email, proof) => { await create(email, proof); throw Error("provider accepted but response was lost"); };
  await assert.rejects(f.run(), error => error.status === 503);
  assert.equal((await f.state()).invitations[f.input.email].status, "failed");
  assert.equal(f.calls.sends, 0);
  assert.equal((await f.storage.prepare("SELECT COUNT(*) AS count FROM members").get()).count, 0);
  const repaired = await f.run("reconcile");
  assert.equal(repaired.invitation.status, "ready");
  assert.equal(f.calls.creates, 1);
  assert.equal(f.calls.sends, 0);
  await f.run("resend");
  assert.equal(f.calls.sends, 1);
});

test("a failed durable reservation never reaches the external provider", async t => {
  const f = await fixture(t);
  f.failWrite(sql => sql.startsWith("UPDATE chapters"));
  await assert.rejects(f.run(), /injected database interruption/);
  assert.deepEqual(f.calls, { creates: 0, sends: 0, finds: 0 });
  assert.equal((await f.state()).invitations, undefined);
});

test("database failure after Auth preparation rolls back membership and can be reconciled", async t => {
  const f = await fixture(t);
  f.failWrite(sql => sql.startsWith("INSERT INTO identities"));
  await assert.rejects(f.run(), error => error.status === 503);
  assert.equal(f.accounts.size, 1);
  assert.equal(f.calls.sends, 0);
  assert.equal((await f.storage.prepare("SELECT COUNT(*) AS count FROM members").get()).count, 0);
  const repaired = await f.run("reconcile");
  assert.equal(repaired.invitation.status, "ready");
  assert.equal(f.calls.creates, 1);
  assert.equal(f.calls.sends, 0);
  assert.equal((await f.storage.prepare("SELECT COUNT(*) AS count FROM identities").get()).count, 3);
});

test("failed final email commit remains unknown; status check and create retry never resend", async t => {
  const f = await fixture(t);
  f.failWrite((sql, args) => sql.startsWith("UPDATE chapters") && JSON.parse(args[0]).invitations?.[f.input.email]?.status === "sent");
  await assert.rejects(f.run(), error => error.status === 503);
  assert.equal(f.calls.sends, 1);
  assert.equal((await f.state()).invitations[f.input.email].status, "delivery_unknown");
  assert.equal((await f.run()).invitation.status, "delivery_unknown");
  assert.equal((await f.run("reconcile")).invitation.status, "delivery_unknown");
  assert.equal(f.calls.sends, 1);
  await assert.rejects(f.run("resend"), error => error.status === 429);
  f.advance(60_001);
  await f.run("resend");
  assert.equal(f.calls.sends, 2);
});

test("ambiguous email timeout preserves usable account and requires an explicit resend", async t => {
  const f = await fixture(t);
  const send = f.provider.send;
  f.provider.send = async account => { await send(account); throw Error("response lost"); };
  await assert.rejects(f.run(), error => error.status === 503);
  assert.equal((await f.state()).invitations[f.input.email].bound, true);
  const checked = await f.run("reconcile");
  assert.equal(checked.invitation.status, "delivery_unknown");
  assert.equal(f.calls.sends, 1);
  assert.equal(f.calls.creates, 1);
});

test("concurrent create and badge reservations cannot produce duplicate accounts or email", async t => {
  const f = await fixture(t);
  const find = f.provider.find;
  let release, started;
  const reached = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.provider.find = async email => { started(); await gate; return find(email); };
  const first = f.run();
  await reached;
  await assert.rejects(f.run(), error => error.status === 409);
  await assert.rejects(f.run("create", { email: "another@example.edu", input: { ...f.input, email: "another@example.edu" } }), error => error.status === 409);
  release();
  await first;
  assert.equal(f.calls.sends, 1);
  assert.equal(f.calls.creates, 1);
});

test("legacy orphan is linked by exact email; existing profile is retained and no email is assumed necessary", async t => {
  const f = await fixture(t);
  f.accounts.set(f.input.email, { id: randomUUID(), email: f.input.email, confirmed: true });
  const result = await f.run();
  assert.equal(result.invitation.status, "delivery_unknown");
  assert.equal(f.calls.creates, 0);
  assert.equal(f.calls.sends, 0);
  await f.storage.prepare("UPDATE members SET tier=5, credits=9 WHERE id=?").run(result.memberId);
  await f.run("reconcile");
  const member = await f.storage.prepare("SELECT tier,credits FROM members WHERE id=?").get(result.memberId);
  assert.equal(member.tier, 5);
  assert.equal(member.credits, 9);
  await f.run("resend");
  assert.equal(f.calls.sends, 1);
});

test("unknown unconfirmed accounts cannot claim a roster identity even when the email matches", async t => {
  const f = await fixture(t);
  const attackerAccount = { id: randomUUID(), email: f.input.email, confirmed: false };
  f.accounts.set(f.input.email, attackerAccount);
  await assert.rejects(f.run(), error => error.status === 409);
  assert.equal(f.calls.creates, 0);
  assert.equal(f.calls.sends, 0);
  assert.equal((await f.storage.prepare("SELECT COUNT(*) AS n FROM members").get()).n, 0);
  attackerAccount.invitationProof = { version: 1, workspace: "chapter", nonce: "f".repeat(64) };
  await assert.rejects(f.run("reconcile"), error => error.status === 409);
  const saved = (await f.state()).invitations[f.input.email];
  attackerAccount.invitationProof = { version: 1, workspace: "another-chapter", nonce: saved.provenance };
  await assert.rejects(f.run("reconcile"), error => error.status === 409);
  assert.equal(f.calls.creates, 0);
  assert.equal(f.calls.sends, 0);
  assert.equal((await f.storage.prepare("SELECT COUNT(*) AS n FROM identities").get()).n, 0);
});

test("known member missing an identity can be repaired without replacing their account", async t => {
  const f = await fixture(t);
  await f.storage.prepare("INSERT INTO members VALUES (?,?,?,?,?,?,?,1)")
    .run("chapter", "existing", f.input.name, f.input.email, "member", 5, 12);
  const result = await f.run("reconcile");
  assert.equal(result.memberId, "existing");
  assert.equal(result.invitation.status, "ready");
  assert.equal((await f.storage.prepare("SELECT tier FROM members WHERE id='existing'").get()).tier, 5);
  assert.equal(f.calls.sends, 0);
});

test("revoked eligibility prevents binding or sending after slow provider creation", async t => {
  const f = await fixture(t);
  let allowed = true;
  const create = f.provider.create;
  f.provider.create = async (email, proof) => { const account = await create(email, proof); allowed = false; return account; };
  await assert.rejects(f.run("create", { guard: () => { if (!allowed) throw Object.assign(Error("member removed"), { status: 409 }); } }), error => error.status === 409);
  assert.equal(f.calls.sends, 0);
  assert.equal((await f.storage.prepare("SELECT COUNT(*) AS count FROM members").get()).count, 0);
  assert.equal(f.accounts.size, 1, "an externally created Auth user is never deleted on rollback");
});

test("inactive or conflicting bindings are never reassigned", async t => {
  const f = await fixture(t);
  const authId = randomUUID();
  f.accounts.set(f.input.email, { id: authId, email: f.input.email, confirmed: false });
  await f.storage.prepare("INSERT INTO members VALUES (?,?,?,?,?,?,?,1)")
    .run("chapter", "someone-else", "Other Member", "other@example.edu", "member", 1, 15);
  await f.storage.prepare("INSERT INTO identities VALUES (?,?,?,?)").run("chapter", "supabase", authId, "someone-else");
  await assert.rejects(f.run(), error => error.status === 409);
  assert.equal(f.calls.sends, 0);
  assert.equal((await f.storage.prepare("SELECT member_id FROM identities WHERE subject=?").get(authId)).member_id, "someone-else");
});

test("expired sending lease is visibly uncertain, not a reason to replay email", async t => {
  const f = await fixture(t);
  await f.run();
  const state = await f.state();
  const record = state.invitations[f.input.email];
  record.status = "sending";
  record.operation = { id: "crashed-request", until: f.clock() + 90_000 };
  await f.setState(state);
  assert.equal(invitationView(record, f.clock()).canReconcile, false);
  f.advance(90_001);
  assert.equal(invitationList(await f.state(), f.clock())[0].status, "delivery_unknown");
  const result = await f.run("reconcile");
  assert.equal(result.invitation.status, "delivery_unknown");
  assert.equal(f.calls.sends, 1);
});

test("interrupted preparation leaves a recoverable status even for an already linked member", async t => {
  const f = await fixture(t);
  await f.run();
  const state = await f.state();
  const record = state.invitations[f.input.email];
  record.status = "preparing";
  record.operation = { id: "crashed-check", until: f.clock() + 90_000 };
  await f.setState(state);
  assert.equal(invitationView(record, f.clock()).canReconcile, false);
  f.advance(90_001);
  const interrupted = invitationView(record, f.clock());
  assert.equal(interrupted.status, "failed");
  assert.equal(interrupted.canReconcile, true);
  assert.equal(interrupted.canResend, false);
  f.provider.find = async () => { throw Error("provider unavailable"); };
  await assert.rejects(f.run("reconcile"), error => error.status === 503);
  const failed = invitationView((await f.state()).invitations[f.input.email], f.clock());
  assert.equal(failed.status, "failed");
  assert.equal(failed.canReconcile, true);
  assert.equal(failed.canResend, false);
  assert.equal(f.calls.sends, 1);
});
