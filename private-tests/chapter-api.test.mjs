import { responseCookies } from "./auth-test-helper.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const chairId = "aab93409-383f-4d8a-b443-3d940a277153";

async function freePort() {
  const socket = createServer();
  await new Promise((ok) => socket.listen(0, "127.0.0.1", ok));
  const port = socket.address().port;
  await new Promise((ok) => socket.close(ok));
  return port;
}

test("chapter accounts bind aliases, restrict chair actions and stop deactivated logins", async () => {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "ato-chapter-auth-test-"));
  const base = `http://127.0.0.1:${port}`;
  const origin = "https://portal.example.test";
  const child = spawn(process.execPath,
    ["--import", join(root, "private-tests/mock-chapter-auth.mjs"), "server/private.mjs"], {
      cwd: root,
      env: {
        ...process.env,
        APP_MODE: "production", AUTH_MODE: "chapter", PORT: String(port),
        PUBLIC_ORIGIN: origin, PRIVATE_DATA_DIR: directory,
        DATABASE_URL: "", VERCEL: "", VERCEL_ENV: "",
        SUPABASE_URL: "https://chapter-test.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(32)}`,
        SUPABASE_SECRET_KEY: `sb_secret_${"b".repeat(32)}`,
        SUPABASE_STORAGE_BUCKET: "",
        TEST_PUBLIC_ROSTER: "true", ROSTER_REQUIRED: "true",
        ROSTER_SOURCE_MODE: "public_email_csv", ROSTER_SHEET_ID: "a".repeat(44), ROSTER_SHEET_GID: "0", ROSTER_SHEET_RANGE: "",
        ROSTER_SERVICE_ACCOUNT_EMAIL: "", ROSTER_SERVICE_ACCOUNT_PRIVATE_KEY: "",
        CHAIR_AUTH_USER_ID: chairId, CHAIR_ACCOUNT_EMAIL: "chair@example.edu",
        CHAPTER_EMAIL_READY: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  let output = "";
  let errorOutput = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  try {
    await new Promise((ok, reject) => {
      const deadline = setTimeout(() => reject(Error(`Server timeout: ${errorOutput}`)), 10_000);
      child.stdout.on("data", () => {
        if (output.includes("ATO scholarship private:")) { clearTimeout(deadline); ok(); }
      });
      child.once("exit", (code) => { clearTimeout(deadline); reject(Error(`Server exited ${code}: ${errorOutput}`)); });
    });
    const request = async (path, body, cookie = "", csrf = "") => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(csrf ? { "X-CSRF-Token": csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      return { status: response.status, payload,
        cookie: responseCookies(response, cookie) };
    };
    const confirmKey = async session => {
      assert.equal(session.payload.recoveryKey.split(' ').length,16);
      const confirmed = await request('/api/account/recovery-key/confirm', {recoveryKey:session.payload.recoveryKey}, session.cookie, session.payload.csrfToken);
      assert.equal(confirmed.status,200,JSON.stringify(confirmed.payload));
      assert.equal((await request('/api/session', undefined, session.cookie)).payload.recoveryKeyPending,false);
    };
    const config = await request("/api/config");
    assert.equal(config.payload.chapterAuth.enabled, true);
    assert.equal(config.payload.chapterAuth.configured, true);
    assert.deepEqual(config.payload.providers, []);
    assert.equal((await request("/api/demo/session", {})).status, 404);
    const demoLogin = await fetch(base + "/demo/login", { redirect: "manual" });
    assert.equal(demoLogin.status, 302);
    assert.equal(demoLogin.headers.get("location"), "/demo/?account=member");
    const chairDemoLogin = await fetch(base + "/demo/login?account=demo-chair", { redirect: "manual" });
    assert.equal(chairDemoLogin.status, 302);
    assert.equal(chairDemoLogin.headers.get("location"), "/demo/?account=chair");
    assert.equal((await fetch(base + "/ato-logo.png")).status, 200);
    const demoScript = await fetch(base + "/demo/app.js");
    assert.equal(demoScript.status, 200);
    assert.match(await demoScript.text(), /selectedDemoAccount/);
    assert.equal((await fetch(base + "/demo/demo-worker.js")).status, 200);
    assert.equal((await request("/auth/microsoft")).status, 404);
    const chair = await request("/api/auth/login", {
      identifier: "chair@example.edu", password: "correct-test-password",
    });
    assert.equal(chair.status, 200, JSON.stringify(chair.payload));
    assert.equal(chair.payload.user.role, "chair");
    assert.equal(chair.payload.user.name, "Scholarship Chair Office");
    assert.equal(chair.payload.recoveryKey, undefined);
    const chairCookie = chair.cookie;
    const chairCsrf = chair.payload.csrfToken;
    assert.equal((await request("/api/admin/roster-sync", {}, chairCookie, chairCsrf)).status, 200);
    const tierPreview = await request("/api/admin/tier-import", undefined, chairCookie);
    assert.equal(tierPreview.status, 200);
    assert.equal(tierPreview.payload.targets.find((entry) => entry.email === "member@example.edu").schoolId, "900123456");
    assert.equal((await request("/api/admin/tier-import", {
      snapshot: tierPreview.payload.snapshot, assignments: [{ email: "new@example.edu", tier: 4 }],
    }, chairCookie, chairCsrf)).status, 422);
    const staged = await request("/api/admin/tier-import", {
      snapshot: tierPreview.payload.snapshot,
      assignments: [{ email: "member@example.edu", tier: 4 }, { email: "new@example.edu", tier: 1 }],
    }, chairCookie, chairCsrf);
    assert.equal(staged.status, 200, JSON.stringify(staged.payload));
    assert.equal(staged.payload.staged, 2);
    const candidates = await request("/api/admin/roster-sync", undefined, chairCookie);
    assert.equal(candidates.payload.candidates.find((entry) => entry.email === "member@example.edu").assignedTier, 4);
    const storage = new DatabaseSync(join(directory, "production", "chapter.sqlite"));
    try {
      const state = storage.prepare("SELECT data FROM chapters WHERE workspace='chapter'").get().data;
      assert.equal(state.includes("900123456"), false);
      assert.equal(state.includes("900999999"), false);
      assert.equal(state.includes('"gpa"'), false);
    } finally { storage.close(); }
    assert.equal((await request("/api/roster", { name: "Member" })).status, 401);
    const added = await request("/api/roster", {
      name: "Sample Member", email: "member@example.edu", badge: "1234",
      tier: 1, credits: 15,
    }, chairCookie, chairCsrf);
    assert.equal(added.status, 201, JSON.stringify(added.payload));
    assert.equal(added.payload.member.tier, 4, "reviewed staged tier is used during invitation");
    const afterInvite = await request("/api/admin/tier-import", undefined, chairCookie);
    assert.equal(afterInvite.payload.targets.find((entry) => entry.email === "member@example.edu").stagedTier, null);
    assert.match(added.payload.loginId, /^KH-[A-F0-9]{10}$/);
    assert.equal((await request("/api/roster", {
      name: "Duplicate", email: "member@example.edu", tier: 1, credits: 15,
    }, chairCookie, chairCsrf)).status, 201);
    const roster = await request("/api/roster", undefined, chairCookie);
    assert.equal(roster.status, 200);
    const rosterById = new Map(roster.payload.members.map((entry) => [entry.id, entry]));
    assert.deepEqual(
      rosterById.get(added.payload.member.id).identities
        .map((identity) => `${identity.provider}:${identity.subject}`).sort(),
      [`login:${added.payload.loginId.toLowerCase()}`, "login:1234"].sort(),
    );
    assert.deepEqual(rosterById.get(chair.payload.user.id).identities, []);
    assert.equal(JSON.stringify(roster.payload).includes("d4dc3984-9c89-4ff7-8075-cbe5b2cd18c4"), false);
    const progress = await request("/api/members", undefined, chairCookie);
    assert.equal(progress.status, 200);
    assert.deepEqual(progress.payload.members.map((entry) => entry.id), [added.payload.member.id]);
    assert.equal(progress.payload.members[0].goal, 90);
    assert.equal(progress.payload.members[0].checkpointDate, [...chair.payload.semester.checkpointDates, chair.payload.semester.targetDate].find(date => date >= chair.payload.today) || chair.payload.semester.targetDate);

    const member = await request("/api/auth/login", {
      identifier: "1234", password: "correct-test-password",
    });
    assert.equal(member.status, 200, JSON.stringify(member.payload));
    assert.equal(member.payload.user.name, "Sample Member");
    assert.equal(member.payload.recoveryKey.split(" ").length, 16);
    // An interrupted key display is recoverable on the next password sign-in.
    const reopened = await request('/api/auth/login', {identifier:'1234',password:'correct-test-password'});
    assert.notEqual(reopened.payload.recoveryKey,member.payload.recoveryKey);
    assert.equal((await request('/api/account/recovery-key/confirm', {recoveryKey:member.payload.recoveryKey}, reopened.cookie, reopened.payload.csrfToken)).status,409);
    member.payload.recoveryKey = reopened.payload.recoveryKey;
    await confirmKey(reopened);
    assert.equal((await request("/api/roster", undefined, member.cookie)).status, 403);
    const byEmail = await request("/api/auth/login", {
      identifier: "member@example.edu", password: "correct-test-password",
    });
    assert.equal(byEmail.payload.user.id, member.payload.user.id);
    assert.equal(byEmail.payload.recoveryKey, undefined);
    const byPortalId = await request("/api/auth/login", {
      identifier: added.payload.loginId, password: "correct-test-password",
    });
    assert.equal(byPortalId.payload.user.id, member.payload.user.id);
    assert.equal(byPortalId.payload.recoveryKey, undefined);
    assert.equal((await request("/api/auth/recover-key", {
      identifier: "1234", recoveryKey: "wrong key", password: "another-long-password",
    })).status, 401);
    assert.equal((await request("/api/auth/recover-key", {
      identifier: "member@example.edu",
      recoveryKey: member.payload.recoveryKey,
      password: "provider-failure-test-password",
    })).status, 503);
    assert.equal((await request('/api/auth/login', {identifier:'1234',password:'correct-test-password'})).status,409);
    const settling = new DatabaseSync(join(directory, 'production', 'chapter.sqlite'));
    try {
      for (const row of settling.prepare("SELECT id,data FROM transactions WHERE kind='auth_mutation'").all()) {
        const data = JSON.parse(row.data); data.busyUntil = Date.now()-1;
        settling.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
      }
    } finally { settling.close(); }
    assert.equal((await request('/api/auth/recover-key', {identifier:'1234', recoveryKey:member.payload.recoveryKey,password:'recovered-test-password'})).status,401);
    const retryLogin = await request('/api/auth/login', {identifier:'1234',password:'correct-test-password'});
    await confirmKey(retryLogin);
    const recovered = await request("/api/auth/recover-key", {
      identifier: added.payload.loginId,
      recoveryKey: retryLogin.payload.recoveryKey,
      password: "recovered-test-password",
    });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.payload));
    assert.equal(recovered.payload.recoveryKey,undefined);
    assert.equal((await request("/api/session", undefined, member.cookie)).status, 401);
    assert.equal((await request("/api/session", undefined, byEmail.cookie)).status, 401);
    assert.equal((await request("/api/session", undefined, byPortalId.cookie)).status, 401);
    assert.equal((await request("/api/auth/recover-key", {
      identifier: "member@example.edu",
      recoveryKey: member.payload.recoveryKey,
      password: "another-long-password",
    })).status, 401);
    const afterRecovery = await request("/api/auth/login", {
      identifier: "member@example.edu", password: "recovered-test-password",
    });
    assert.equal(afterRecovery.status, 200);
    await confirmKey(afterRecovery);

    const reset = await request(`/api/roster/${member.payload.user.id}/reset-password`, {}, chairCookie, chairCsrf);
    assert.equal(reset.status, 200);
    const publicReset = await request("/api/auth/request-reset", { identifier: "1234" });
    assert.equal(publicReset.status, 200);
    assert.equal((await request("/api/auth/request-reset", {
      identifier: "member@example.edu",
    })).status, 200);
    assert.equal((await request("/api/auth/request-reset", {
      identifier: added.payload.loginId,
    })).status, 200);
    assert.equal((await request("/api/auth/request-reset", {
      identifier: "1234",
    })).status, 429);
    const failedSetup = await request("/api/auth/complete", {
      accessToken: "test-account-token", password: "short",
    });
    assert.equal(failedSetup.status, 422);
    assert.equal(failedSetup.payload.recoveryKey, undefined);
    const completedSetup = await request("/api/auth/complete", {
      accessToken: "test-account-token", password: "a-long-new-password",
    });
    assert.equal(completedSetup.status, 200);
    assert.equal(completedSetup.payload.recoveryKey,undefined);
    assert.equal((await request("/api/session", undefined, member.cookie)).status, 401);
    assert.equal((await request("/api/session", undefined, byEmail.cookie)).status, 401);
    assert.equal((await request("/api/session", undefined, byPortalId.cookie)).status, 401);
    assert.equal((await request("/api/session", undefined, afterRecovery.cookie)).status, 401);
    const afterEmailReset = await request("/api/auth/login", {
      identifier: "1234", password: "a-long-new-password",
    });
    assert.equal(afterEmailReset.status, 200);
    await confirmKey(afterEmailReset);
    const preview = await request("/api/semester/preview", undefined, chairCookie);
    assert.equal(preview.status, 200);
    const nextSemester = await request("/api/semester/reset", {
      confirm: "DELETE SEMESTER",
      previewToken: preview.payload.previewToken,
      semester: {
        name: "Next test semester",
        startDate: "2026-09-01",
        checkpointDates: ["2026-09-10", "2026-10-01", "2026-11-01"],
        targetDate: "2026-12-01",
        endDate: "2026-12-15",
      },
    }, chairCookie, chairCsrf);
    assert.equal(nextSemester.status, 200, JSON.stringify(nextSemester.payload));
    const nextProgress = await request("/api/members", undefined, chairCookie);
    assert.equal(nextProgress.status, 200);
    assert.equal(nextProgress.payload.members[0].checkpointDate, ["2026-09-10", "2026-10-01", "2026-11-01", "2026-12-01"].find(date => date >= chair.payload.today) || "2026-12-01");
    const afterSemester = await request("/api/auth/login", {
      identifier: added.payload.loginId, password: "a-long-new-password",
    });
    assert.equal(afterSemester.status, 200);
    assert.equal(afterSemester.payload.recoveryKey.split(" ").length, 16);
    assert.notEqual(afterSemester.payload.recoveryKey, afterEmailReset.payload.recoveryKey);
    await confirmKey(afterSemester);
    assert.equal((await request("/api/auth/recover-key", {
      identifier: "1234",
      recoveryKey: afterEmailReset.payload.recoveryKey,
      password: "another-long-password",
    })).status, 401);
    for (let i = 0; i < 3; i++) {
      const identifier = ["1234", "member@example.edu", added.payload.loginId][i % 3];
      assert.equal((await request("/api/auth/recover-key", {
        identifier, recoveryKey: "wrong key", password: "another-long-password",
      })).status, 401);
    }
    assert.equal((await request("/api/auth/recover-key", {
      identifier: added.payload.loginId,
      recoveryKey: "wrong key",
      password: "another-long-password",
    })).status, 429);
    for (let i = 0; i < 10; i++)
      assert.equal((await request("/api/auth/login", {
        identifier: i % 2 ? "UNKNOWN-BADGE" : "unknown-badge", password: "wrong-password",
      })).status, 401);
    assert.equal((await request("/api/auth/login", {
      identifier: "unknown-badge", password: "wrong-password",
    })).status, 429);
    const changeBody = { currentPassword: "a-long-new-password", newPassword: "member-changed-password", confirmPassword: "member-changed-password" };
    assert.equal((await request("/api/account/password", changeBody)).status, 401);
    assert.equal((await request("/api/account/password", changeBody, afterSemester.cookie)).status, 403);
    assert.equal((await request("/api/account/password", {...changeBody, confirmPassword:"mismatch-password"}, afterSemester.cookie, afterSemester.payload.csrfToken)).status, 422);
    assert.equal((await request("/api/account/password", {...changeBody, currentPassword:"wrong-password"}, afterSemester.cookie, afterSemester.payload.csrfToken)).status, 401);
    assert.equal((await request("/api/session", undefined, afterSemester.cookie)).status, 200);
    assert.equal((await request("/api/account/password", changeBody, afterSemester.cookie, afterSemester.payload.csrfToken)).status, 200);
    assert.equal((await request("/api/session", undefined, afterSemester.cookie)).status, 401);
    assert.equal((await request("/api/auth/login", {identifier:"1234",password:"a-long-new-password"})).status, 401);
    const changedLogin = await request("/api/auth/login", {identifier:"1234",password:"member-changed-password"});
    assert.equal(changedLogin.status, 200);
    await confirmKey(changedLogin);
    const deactivated = await request(`/api/roster/${member.payload.user.id}/deactivate`, {}, chairCookie, chairCsrf);
    assert.equal(deactivated.status, 200);
    assert.equal((await request("/api/session", undefined, member.cookie)).status, 401);
    assert.equal((await request("/api/auth/login", {
      identifier: "1234", password: "correct-test-password",
    })).status, 401);
    const chairSetup = await request("/api/auth/complete", {
      accessToken: "test-chair-account-token", password: "a-new-chair-password",
    });
    assert.equal(chairSetup.status, 200);
    assert.equal(chairSetup.payload.recoveryKey, undefined);
    assert.equal((await request("/api/session", undefined, chairCookie)).status, 401);
    for (let i = 0; i < 9; i++) {
      const identifier = ["1234", "member@example.edu", added.payload.loginId][i % 3];
      assert.equal((await request("/api/auth/login", {
        identifier, password: "wrong-password",
      })).status, 401);
    }
    assert.equal((await request("/api/auth/login", {
      identifier: added.payload.loginId, password: "wrong-password",
    })).status, 429);
  } finally {
    child.kill("SIGTERM");
    await rm(directory, { recursive: true, force: true });
  }
});
