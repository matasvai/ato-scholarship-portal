import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { responseCookies } from "./auth-test-helper.mjs";

test("Chair prepares and edits roster accounts without email, preserving identity and academic controls", async t => {
  const root = resolve(import.meta.dirname, ".."), origin = "https://portal.example.test";
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "ato-account-settings-"));
  const providerLog = join(directory, "provider.log");
  const child = spawn(process.execPath, ["--import", join(root, "private-tests/mock-chapter-auth.mjs"), "server/private.mjs"], {
    cwd: root, env: {
      ...process.env, APP_MODE: "production", AUTH_MODE: "chapter", PORT: String(port), PUBLIC_ORIGIN: origin,
      PRIVATE_DATA_DIR: directory, DATABASE_URL: "", VERCEL: "", VERCEL_ENV: "", APP_ENCRYPTION_KEY: "",
      SUPABASE_URL: "https://chapter-test.supabase.co", SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
      SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`, SUPABASE_STORAGE_BUCKET: "",
      TEST_PUBLIC_ROSTER: "true", ROSTER_REQUIRED: "true", ROSTER_SOURCE_MODE: "public_email_csv",
      ROSTER_SHEET_ID: "a".repeat(44), ROSTER_SHEET_GID: "0", ROSTER_SHEET_RANGE: "",
      ROSTER_SERVICE_ACCOUNT_EMAIL: "", ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: "", TEST_AUTH_PREENROLLED: "",
      CHAIR_AUTH_USER_ID: "aab93409-383f-4d8a-b443-3d940a277153", CHAIR_ACCOUNT_EMAIL: "chair@example.edu",
      CHAPTER_EMAIL_READY: "false", TEST_AUTH_PROVIDER_LOG: providerLog,
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(async () => {
    child.kill();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`Server timeout: ${stderr}`)), 10000);
    child.stdout.on("data", chunk => { if (String(chunk).includes("ATO scholarship private:")) { clearTimeout(timeout); resolve(); } });
    child.once("exit", code => { clearTimeout(timeout); reject(Error(`Server exited ${code}: ${stderr}`)); });
  });
  const request = async (path, body, cookie = "", csrf = "") => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json(), cookie: responseCookies(response, cookie) };
  };
  const input = { name: "Fictional Member", email: "member@example.edu", badge: "1234", tier: 4, credits: 15 };
  const prepare = "/api/admin/invitations/prepare";
  assert.equal((await request(prepare, input)).status, 401);
  const chair = await request("/api/auth/login", { identifier: "chair@example.edu", password: "correct-test-password" });
  assert.equal(chair.status, 200);
  const send = (path, body) => request(path, body, chair.cookie, chair.payload.csrfToken);
  assert.equal((await send("/api/admin/roster-sync", {})).status, 200);
  assert.equal((await request(prepare, input, chair.cookie)).status, 403, "CSRF is required");
  assert.equal((await send(prepare, { ...input, email: "unlisted@example.edu" })).status, 409);
  assert.equal((await send("/api/roster", input)).status, 503, "legacy invitation remains gated on email readiness");
  const prepared = await send(prepare, input);
  assert.equal(prepared.status, 201, JSON.stringify(prepared.payload));
  assert.equal(prepared.payload.invitation.status, "ready");
  assert.equal((await send(prepare, { ...input, name: "Retry must not overwrite", tier: 1 })).payload.member.id, prepared.payload.member.id);
  const memberId = prepared.payload.member.id, route = `/api/roster/${memberId}/account-settings`;
  const current = await send(route);
  assert.equal(current.payload.member.name, input.name);
  assert.equal(current.payload.badge, "1234");
  assert.equal(current.payload.loginId, prepared.payload.loginId);
  const candidates = await send("/api/admin/roster-sync");
  const candidate = candidates.payload.candidates.find(entry => entry.email === input.email);
  assert.equal(candidate.accountStatus, "account_ready");
  assert.equal(candidate.accountId, memberId);
  assert.equal(candidate.assignedTier, 4);
  const edit = { name: "Renamed Fictional Member", badge: "5678", tier: 3, credits: 12, version: current.payload.version };
  assert.equal((await request(route, edit, chair.cookie)).status, 403);
  assert.equal((await send(route, { ...edit, email: "other@example.edu" })).status, 422);
  const providerBefore = await readFile(providerLog, "utf8");
  const saved = await send(route, edit);
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.member.name, edit.name);
  assert.equal(saved.payload.member.email, input.email);
  assert.equal(saved.payload.member.tier, 3);
  assert.equal(saved.payload.member.credits, 12);
  assert.equal(saved.payload.badge, "5678");
  assert.equal(saved.payload.loginId, current.payload.loginId, "permanent login is stable");
  assert.equal(await readFile(providerLog, "utf8"), providerBefore, "editing calls no external auth or mail provider");
  assert.equal((await send(route, edit)).status, 409, "stale concurrent saves are rejected");
  const storage = new DatabaseSync(join(directory, "production", "chapter.sqlite"));
  try {
    const state = () => JSON.parse(storage.prepare("SELECT data FROM chapters WHERE workspace='chapter'").get().data);
    const setState = value => storage.prepare("UPDATE chapters SET data=? WHERE workspace='chapter'").run(JSON.stringify(value));
    assert.equal(storage.prepare("SELECT member_id FROM identities WHERE provider='login' AND subject='1234'").get(), undefined);
    assert.equal(storage.prepare("SELECT member_id FROM identities WHERE provider='login' AND subject='5678'").get().member_id, memberId);
    assert.equal(state().invitations[input.email].badge, "5678");
    assert.equal(state().invitations[input.email].tier, 3);
    assert.equal(state().invitations[input.email].credits, 12);
    assert.equal((await send("/api/admin/invitations/member%40example.edu/reconcile", {})).status, 200);
    assert.equal(storage.prepare("SELECT member_id FROM identities WHERE provider='login' AND subject='1234'").get(), undefined, "reconcile cannot restore removed badge");
    assert.equal((await send("/api/admin/invitations/member%40example.edu/resend", {})).status, 503);
    assert.equal((await send("/api/admin/invitations/member%40example.edu/send-initial", {})).status, 503);
    const freshEdit = async changes => ({ ...edit, version: (await send(route)).payload.version, ...changes });
    let value = state();
    value.invitations["reserved@example.edu"] = { email: "reserved@example.edu", badge: "reserved-badge", alias: "reserved-login" };
    setState(value);
    assert.equal((await send(route, await freshEdit({ badge: "reserved-badge" }))).status, 409);
    value = state(); value.classCreditsManaged = { [memberId]: true }; setState(value);
    assert.equal((await send(route, await freshEdit({ credits: 15 }))).status, 409, "approved class totals cannot be overwritten");
    value = state(); value.invitations[input.email].operation = { id: "busy", until: Date.now() + 60000 }; setState(value);
    assert.equal((await send(route, await freshEdit({ name: "Busy edit" }))).status, 409);
    value = state(); delete value.invitations[input.email].operation; setState(value);
    const newMember = await send(prepare, { name: "Fictional New Member", email: "new@example.edu", badge: "8888", tier: 5, credits: 15 });
    assert.equal(newMember.status, 201, JSON.stringify(newMember.payload));
    assert.equal(newMember.payload.member.tier, 1);
    const newRoute = `/api/roster/${newMember.payload.member.id}/account-settings`;
    const newSettings = await send(newRoute);
    assert.equal((await send(newRoute, { ...edit, badge: "8888", tier: 2, version: newSettings.payload.version })).status, 422);
    assert.equal((await send(route, await freshEdit({ badge: "8888" }))).status, 409, "another member's alias cannot be taken");
    const member = await request("/api/auth/login", { identifier: "5678", password: "correct-test-password" });
    assert.equal(member.status, 200);
    assert.equal((await request(route, undefined, member.cookie)).status, 403);
    assert.equal((await request(route, await freshEdit({}), member.cookie, member.payload.csrfToken)).status, 403);
    assert.equal((await request(prepare, input, member.cookie, member.payload.csrfToken)).status, 403);
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='roster.invitation_send_started'").get().n, 0);
    assert.equal(/\/auth\/v1\/(invite|recover)/.test(await readFile(providerLog, "utf8")), false, "no emails were requested in this flow");
  } finally { storage.close(); }
});
