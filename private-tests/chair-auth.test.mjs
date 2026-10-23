import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { responseCookies } from './auth-test-helper.mjs';
import { authMutationVersion, assertAuthMutationVersion, beginAuthMutation, finishAuthMutation } from '../server/auth-mutation.mjs';

const root = resolve(import.meta.dirname, '..'), origin = 'https://portal.example.test';
async function setup(t, { delayToken = false, preenrolled = false } = {}) {
  const socket = createServer();
  await new Promise(ok => socket.listen(0, '127.0.0.1', ok));
  const port = socket.address().port;
  await new Promise(ok => socket.close(ok));
  const directory = await mkdtemp(join(tmpdir(), 'ato-chair-auth-'));
  const child = spawn(process.execPath, ['--import', join(root, 'private-tests/mock-chapter-auth.mjs'), 'server/private.mjs'], {
    cwd: root, env: { ...process.env, APP_MODE: 'production', AUTH_MODE: 'chapter', PORT: String(port), PUBLIC_ORIGIN: origin,
      PRIVATE_DATA_DIR: directory, DATABASE_URL: '', VERCEL: '', VERCEL_ENV: '', APP_ENCRYPTION_KEY: '',
      SUPABASE_URL: 'https://chapter-test.supabase.co', SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'a'.repeat(32)}`, SUPABASE_SECRET_KEY: `sb_secret_${'b'.repeat(32)}`,
      SUPABASE_STORAGE_BUCKET: '', ROSTER_REQUIRED: 'false', ROSTER_SHEET_ID: '', TEST_PUBLIC_ROSTER: '', TEST_AUTH_PREENROLLED: String(preenrolled), TEST_AUTH_PROVIDER_LOG: join(directory, 'provider.log'), TEST_AUTH_TOKEN_SIGNAL: delayToken ? join(directory, 'token-started') : '',
      CHAIR_AUTH_USER_ID: 'aab93409-383f-4d8a-b443-3d940a277153', CHAIR_ACCOUNT_EMAIL: 'chair@example.edu', CHAPTER_EMAIL_READY: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', part => stderr += part);
  t.after(async () => { child.kill(); await new Promise(ok => child.exitCode !== null ? ok() : child.once('exit', ok)); await rm(directory, { recursive: true, force: true }); });
  await new Promise((ok, reject) => {
    const deadline = setTimeout(() => reject(Error(`Server timeout: ${stderr}`)), 10000);
    child.stdout.on('data', part => { if (String(part).includes('ATO scholarship private:')) { clearTimeout(deadline); ok(); } });
    child.once('exit', code => { clearTimeout(deadline); reject(Error(`Server exited ${code}: ${stderr}`)); });
  });
  const request = async (path, body, cookie = '', csrf = '', requestOrigin = origin) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: requestOrigin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, payload: await response.json(), cookie: responseCookies(response, cookie) };
  };
  const login = () => request('/api/auth/login', { identifier: 'chair@example.edu', password: 'correct-test-password' });
  return { request, login, providerLog: () => readFile(join(directory, 'provider.log'), 'utf8'), signal: join(directory, 'token-started'), storage: () => new DatabaseSync(join(directory, 'production', 'chapter.sqlite')) };
}

for (const preenrolled of [false, true]) {
  test(`Chair password login opens authorized Chair access without authenticator (legacy factor: ${preenrolled})`, async t => {
    const c = await setup(t, { preenrolled });
    assert.equal((await c.request('/api/roster')).status, 401);
    assert.equal((await c.request('/api/auth/login', { identifier: 'chair@example.edu', password: 'wrong-password' })).status, 401);
    const chair = await c.login();
    assert.equal(chair.status, 200, JSON.stringify(chair.payload));
    assert.equal(chair.payload.user.role, 'chair');
    assert.equal(chair.payload.mfaRequired, undefined);
    assert.equal(chair.payload.mfa, undefined);
    assert.equal(chair.payload.accessToken, undefined);
    assert.equal(chair.payload.hasVerifiedFactors, undefined);
    assert.match(chair.cookie, /__Host-ato_session=/);
    assert.equal(chair.cookie.includes('ato_chair_mfa='), false);
    for (const path of ['/api/session', '/api/roster', '/api/submissions'])
      assert.equal((await c.request(path, undefined, chair.cookie)).status, 200);
    assert.equal((await c.request('/api/account/password', { currentPassword: 'correct-test-password', newPassword: 'replacement-password', confirmPassword: 'replacement-password' }, chair.cookie)).status, 403, 'CSRF still protects Chair writes');
    const db = c.storage();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind LIKE 'chair_mfa_%'").get().n, 0);
    db.close();
    assert.doesNotMatch(await c.providerLog(), /\/factors/);
  });

  test(`Chair email reset preserves password-only access and revokes sessions (legacy factor: ${preenrolled})`, async t => {
    const c = await setup(t, { preenrolled }), chair = await c.login();
    const password = 'replacement-chair-password';
    for (const [accessToken, status] of [['invalid-token', 401], ['test-account-token', 403]]) {
      const denied = await c.request('/api/auth/complete', { accessToken, password });
      assert.equal(denied.status, status);
      assert.equal((await c.request('/api/session', undefined, chair.cookie)).status, 200, 'unapproved token cannot revoke the Chair session');
    }
    const reset = await c.request('/api/auth/complete', { accessToken: 'test-chair-account-token', password });
    assert.equal(reset.status, 200, JSON.stringify(reset.payload));
    assert.equal(reset.payload.mfaRequired, undefined);
    assert.equal(reset.payload.user, undefined);
    assert.equal((await c.request('/api/session', undefined, reset.cookie)).status, 401, 'reset does not grant a session');
    assert.equal((await c.request('/api/session', undefined, chair.cookie)).status, 401);
    assert.equal((await c.login()).status, 401);
    const updated = await c.request('/api/auth/login', { identifier: 'chair@example.edu', password });
    assert.equal(updated.payload.user.role, 'chair');
    const providerLog = await c.providerLog();
    assert.doesNotMatch(providerLog, /\/factors/);
    if (preenrolled) {
      assert.match(providerLog, /PUT \/auth\/v1\/admin\/users\/aab93409-383f-4d8a-b443-3d940a277153/);
      assert.doesNotMatch(providerLog, /PUT \/auth\/v1\/user\n/);
    } else assert.match(providerLog, /PUT \/auth\/v1\/user\n/);
  });
}

test('retired authenticator cookies and endpoints cannot grant access, and legacy state is cleaned at login', async t => {
  const c = await setup(t), first = await c.login(), db = c.storage();
  db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?)').run('legacy-pending', 'chair_mfa_pending', first.payload.user.id, 'obsolete-encrypted-state', Date.now() + 100000);
  db.close();
  const legacyCookie = `__Host-ato_chair_mfa=${'a'.repeat(64)}`;
  assert.equal((await c.request('/api/session', undefined, legacyCookie)).status, 401);
  for (const path of ['/api/auth/mfa', '/api/auth/mfa/verify', '/api/auth/mfa/cancel']) {
    assert.equal((await c.request(path, undefined, legacyCookie)).status, 404);
    assert.equal((await c.request(path, { code: '123456' }, legacyCookie)).status, 404);
  }
  const login = await c.request('/api/auth/login', { identifier: 'chair@example.edu', password: 'correct-test-password' }, legacyCookie);
  assert.equal(login.status, 200);
  assert.equal(login.cookie.includes('ato_chair_mfa='), false);
  const storage = c.storage();
  assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind='chair_mfa_pending'").get().n, 0);
  storage.close();
});

test('enrolled Chair password change requires the current password and revokes every old portal session', async t => {
  const c = await setup(t, { preenrolled: true }), chair = await c.login(), another = await c.login();
  const body = { currentPassword: 'correct-test-password', newPassword: 'changed-chair-password', confirmPassword: 'changed-chair-password' };
  assert.equal((await c.request('/api/account/password', { ...body, currentPassword: 'wrong-password' }, chair.cookie, chair.payload.csrfToken)).status, 401);
  assert.equal((await c.request('/api/session', undefined, chair.cookie)).status, 200);
  assert.equal((await c.request('/api/account/password', body, chair.cookie, chair.payload.csrfToken)).status, 200);
  for (const cookie of [chair.cookie, another.cookie]) assert.equal((await c.request('/api/session', undefined, cookie)).status, 401);
  assert.equal((await c.login()).status, 401);
  assert.equal((await c.request('/api/auth/login', { identifier: 'chair@example.edu', password: body.newPassword })).payload.user.role, 'chair');
  assert.doesNotMatch(await c.providerLog(), /\/factors/);
});

test('deactivated Chair cannot log in, use an existing session, or complete an email reset', async t => {
  const c = await setup(t, { preenrolled: true }), chair = await c.login(), db = c.storage();
  db.prepare("UPDATE members SET active=0 WHERE role='chair'").run(); db.close();
  assert.equal((await c.login()).status, 401);
  assert.equal((await c.request('/api/roster', undefined, chair.cookie)).status, 401);
  assert.equal((await c.request('/api/auth/complete', { accessToken: 'test-chair-account-token', password: 'replacement-password' })).status, 403);
  assert.doesNotMatch(await c.providerLog(), /PUT/);
});

test('Chair login attempts remain rate limited without an authenticator', async t => {
  const c = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await c.request('/api/auth/login', { identifier: 'chair@example.edu', password: 'wrong-password' })).status, 401);
  assert.equal((await c.login()).status, 429);
});

test('password mutation revokes legacy pending sign-ins and sessions, blocks stale login epochs, and preserves newer fences', async () => {
  const storage = new DatabaseSync(':memory:');
  storage.exec('CREATE TABLE transactions(id TEXT PRIMARY KEY,kind TEXT,session_id TEXT,data TEXT,expires INTEGER); CREATE TABLE sessions(id TEXT,workspace TEXT,member_id TEXT);');
  const db = { prepare: sql => storage.prepare(sql.replace(/ FOR UPDATE/g, '')) };
  try {
    storage.prepare('INSERT INTO sessions VALUES (?,?,?)').run('old-session', 'chapter', 'chair-member');
    storage.prepare('INSERT INTO transactions VALUES (?,?,?,?,?)').run('pending', 'chair_mfa_pending', 'chair-member', 'encrypted', Date.now() + 100000);
    storage.prepare('INSERT INTO transactions VALUES (?,?,?,?,?)').run('receipt', 'chair_mfa_verified', 'old-session', '{}', Date.now() + 100000);
    const old = await authMutationVersion(db, 'chapter', 'chair-member');
    const epoch = await beginAuthMutation(db, 'chapter', 'chair-member');
    assert.equal(storage.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind LIKE 'chair_mfa_%'").get().n, 0);
    await assert.rejects(authMutationVersion(db, 'chapter', 'chair-member'), { status: 409 });
    await assert.rejects(beginAuthMutation(db, 'chapter', 'chair-member'), { status: 409 });
    await finishAuthMutation(db, 'chapter', 'chair-member', 'wrong-epoch');
    await assert.rejects(authMutationVersion(db, 'chapter', 'chair-member'), { status: 409 });
    await finishAuthMutation(db, 'chapter', 'chair-member', epoch);
    assert.equal(await authMutationVersion(db, 'chapter', 'chair-member'), epoch);
    await assert.rejects(assertAuthMutationVersion(db, 'chapter', 'chair-member', old), { status: 401 });
    await assertAuthMutationVersion(db, 'chapter', 'chair-member', epoch);
    const next = await beginAuthMutation(db, 'chapter', 'chair-member');
    await finishAuthMutation(db, 'chapter', 'chair-member', epoch);
    await assert.rejects(authMutationVersion(db, 'chapter', 'chair-member'), { status: 409 });
    await finishAuthMutation(db, 'chapter', 'chair-member', next);
  } finally { storage.close(); }
});


test('initial Chair password setup invalidates a bootstrap password login already in flight', async t => {
  const c = await setup(t, { delayToken: true });
  const login = c.login();
  let started = false;
  for (let i = 0; i < 200; i++) {
    try { await readFile(c.signal); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  assert.equal(started, true, 'provider has verified the original password');
  const reset = await c.request('/api/auth/complete', { accessToken: 'test-chair-account-token', password: 'replacement-test-password' });
  assert.equal(reset.status, 200, JSON.stringify(reset.payload));
  assert.equal((await login).status, 401, 'old password cannot create a session after setup');
  const db = c.storage();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind='chair_mfa_pending'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  db.close();
  const retry = await c.request('/api/auth/login', { identifier: 'chair@example.edu', password: 'replacement-test-password' });
  assert.equal(retry.payload.user.role, 'chair');
  assert.equal(retry.payload.mfaRequired, undefined);
});

test('a delayed first Chair login cannot skip an epoch created after another request bootstraps the account', async t => {
  const c = await setup(t, { delayToken: true }), login = c.login();
  let started = false;
  for (let i = 0; i < 200; i++) {
    try { await readFile(c.signal); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  assert.equal(started, true);
  const storage = c.storage();
  storage.prepare('INSERT INTO members VALUES (?,?,?,?,?,?,?,?)').run('chapter', 'concurrent-chair', 'Chair Office', 'chair@example.edu', 'chair', 1, 15, 1);
  storage.prepare('INSERT INTO identities VALUES (?,?,?,?)').run('chapter', 'supabase', 'aab93409-383f-4d8a-b443-3d940a277153', 'concurrent-chair');
  const db = { prepare: sql => storage.prepare(sql.replace(/ FOR UPDATE/g, '')) };
  const epoch = await beginAuthMutation(db, 'chapter', 'concurrent-chair');
  await finishAuthMutation(db, 'chapter', 'concurrent-chair', epoch);
  assert.equal((await login).status, 401, 'retry must now resolve the member and capture its current epoch');
  assert.equal(storage.prepare("SELECT COUNT(*) AS n FROM transactions WHERE kind='chair_mfa_pending'").get().n, 0);
  storage.close();
});
