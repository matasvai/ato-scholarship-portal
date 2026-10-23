import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { responseCookies } from "./auth-test-helper.mjs";

test("Chair invitation API repairs interrupted setup without mail, protects resend, and preserves roster decisions", async t => {
  const root = resolve(import.meta.dirname, ".."), origin = "https://portal.example.test";
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), "ato-invitations-api-"));
  const child = spawn(process.execPath, ["--import", join(root, "private-tests/mock-chapter-auth.mjs"), "server/private.mjs"], {
    cwd: root, env: {
      ...process.env, APP_MODE: "production", AUTH_MODE: "chapter", PORT: String(port), PUBLIC_ORIGIN: origin,
      PRIVATE_DATA_DIR: directory, DATABASE_URL: "", VERCEL: "", VERCEL_ENV: "", APP_ENCRYPTION_KEY: "",
      SUPABASE_URL: "https://chapter-test.supabase.co", SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
      SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`, SUPABASE_STORAGE_BUCKET: "",
      TEST_PUBLIC_ROSTER: "true", ROSTER_REQUIRED: "true", ROSTER_SOURCE_MODE: "public_email_csv",
      ROSTER_SHEET_ID: "a".repeat(44), ROSTER_SHEET_GID: "0", ROSTER_SHEET_RANGE: "",
      ROSTER_SERVICE_ACCOUNT_EMAIL: "", ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: "", TEST_AUTH_PREENROLLED: "",
      CHAIR_AUTH_USER_ID: "aab93409-383f-4d8a-b443-3d940a277153", CHAIR_ACCOUNT_EMAIL: "chair@example.edu", CHAPTER_EMAIL_READY: "true",
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
  const routes = "/api/admin/invitations/member%40example.edu";
  assert.equal((await request("/api/admin/invitations")).status, 401);
  const chair = await request("/api/auth/login", { identifier: "chair@example.edu", password: "correct-test-password" });
  assert.equal(chair.payload.mfaRequired, undefined);
  assert.equal(chair.status, 200, JSON.stringify(chair.payload));
  const chairRequest = (path, body) => request(path, body, chair.cookie, chair.payload.csrfToken);
  assert.equal((await chairRequest("/api/admin/roster-sync", {})).status, 200);
  const preview = await chairRequest("/api/admin/tier-import");
  assert.equal((await chairRequest("/api/admin/tier-import", {
    snapshot: preview.payload.snapshot, assignments: [{ email: "member@example.edu", tier: 4 }],
  })).status, 200);
  assert.equal((await chairRequest("/api/roster", { name: "Unlisted", email: "unlisted@example.edu", tier: 1, credits: 15 })).status, 422);
  const input = { name: "Fictional Member", email: "member@example.edu", badge: "1234", tier: 1, credits: 15 };
  const created = await chairRequest("/api/roster", input);
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.member.tier, 4);
  assert.equal(created.payload.invitation.status, "sent");
  assert.equal((await chairRequest("/api/roster", input)).payload.member.id, created.payload.member.id);
  assert.equal((await request(`${routes}/resend`, {}, chair.cookie)).status, 403);
  assert.equal((await chairRequest(`${routes}/resend`, {})).status, 429);
  assert.equal((await chairRequest(`${routes}/reconcile`, { tier: 5 })).status, 422);
  const storage = new DatabaseSync(join(directory, "production", "chapter.sqlite"));
  try {
    const state = JSON.parse(storage.prepare("SELECT data FROM chapters WHERE workspace='chapter'").get().data);
    state.invitations[input.email].status = "sending";
    state.invitations[input.email].operation = { id: "crashed-request", until: Date.now() - 1000 };
    storage.prepare("UPDATE chapters SET data=? WHERE workspace='chapter'").run(JSON.stringify(state));
    storage.prepare("DELETE FROM identities WHERE provider='supabase' AND member_id=?").run(created.payload.member.id);
    const status = await chairRequest("/api/admin/invitations");
    assert.equal(status.payload.invitations[0].status, "delivery_unknown");
    assert.equal(JSON.stringify(status.payload).includes("authUserId"), false);
    const repaired = await chairRequest(`${routes}/reconcile`, {});
    assert.equal(repaired.status, 200, JSON.stringify(repaired.payload));
    assert.equal(repaired.payload.member.id, created.payload.member.id);
    assert.equal(repaired.payload.invitation.status, "delivery_unknown");
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='roster.invitation_send_started'").get().n, 1);
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM identities WHERE provider='supabase' AND member_id=?").get(created.payload.member.id).n, 1);
    const list = await chairRequest("/api/admin/roster-sync");
    assert.equal(list.payload.candidates.find(entry => entry.email === input.email).invitation.status, "delivery_unknown");
    storage.prepare("INSERT INTO members VALUES (?,?,?,?,?,?,?,1)")
      .run("chapter", "legacy-member", "Existing New Member", "new@example.edu", "member", 1, 9);
    const legacyStatus = await chairRequest("/api/admin/invitations");
    const legacyEntry = legacyStatus.payload.invitations.find(entry => entry.email === "new@example.edu");
    assert.equal(legacyEntry.status, "untracked");
    assert.equal(legacyEntry.canReconcile, true);
    assert.equal(legacyEntry.canResend, false);
    const legacyRepair = await chairRequest("/api/admin/invitations/new%40example.edu/reconcile", {});
    assert.equal(legacyRepair.status, 200, JSON.stringify(legacyRepair.payload));
    assert.equal(legacyRepair.payload.member.id, "legacy-member");
    assert.equal(legacyRepair.payload.member.credits, 9);
    assert.equal(legacyRepair.payload.member.tier, 1);
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='roster.invitation_send_started'").get().n, 1);
    const member = await request("/api/auth/login", { identifier: "1234", password: "correct-test-password" });
    assert.equal(member.status, 200, JSON.stringify(member.payload));
    assert.equal((await request("/api/admin/invitations", undefined, member.cookie)).status, 403);
    assert.equal((await request(`${routes}/reconcile`, {}, member.cookie, member.payload.csrfToken)).status, 403);
  } finally { storage.close(); }
});
