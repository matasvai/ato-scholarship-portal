import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { authMutationVersion, assertAuthMutationVersion } from '../server/auth-mutation.mjs';
import { setChairAccess } from '../scripts/chair-access.mjs';

test('operator pause/resume revokes only the exact Chair sessions and legacy pending sign-ins, invalidates in-flight sign-in, retains records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ato-chair-handoff-test-'));
  const db = await openDatabase({ directory, env: {} });
  try {
    for (const [id, role] of [['chair', 'chair'], ['member', 'member']]) {
      await db.prepare('INSERT INTO members(workspace,id,name,email,role,tier,credits) VALUES (?,?,?,?,?,?,?)').run('chapter', id, `Fictional ${id}`, `${id}@example.invalid`, role, 1, 15);
      await db.prepare('INSERT INTO sessions(id,workspace,member_id,csrf,expires) VALUES (?,?,?,?,?)').run(`${id}-session`, 'chapter', id, 'fictional-csrf', Date.now() + 60000);
    }
    await db.prepare('INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,?,?,?,?)').run('pending', 'chair_mfa_pending', 'chair', '{}', Date.now() + 60000);
    await db.prepare('INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,?,?,?,?)').run('verified', 'chair_mfa_verified', 'chair-session', '{}', Date.now() + 60000);
    const originalEpoch = await authMutationVersion(db, 'chapter', 'chair');
    for (const bad of [{ memberId: 'member', action: 'suspend', confirmation: 'SUSPEND CHAIR' }, { memberId: 'chair', action: 'suspend', confirmation: '' }, { memberId: 'chair', action: 'resume', confirmation: 'VERIFIED CHAIR HANDOFF' }]) {
      await assert.rejects(setChairAccess({ db, ...bad }));
    }
    assert.equal((await db.prepare('SELECT id FROM sessions').all()).length, 2);
    const suspended = await setChairAccess({ db, memberId: 'chair', action: 'suspend', confirmation: 'SUSPEND CHAIR' });
    assert.equal(suspended.status, 'suspended');
    assert.equal((await db.prepare('SELECT active FROM members WHERE id=?').get('chair')).active, 0);
    assert.deepEqual((await db.prepare('SELECT id FROM sessions').all()).map(row => row.id), ['member-session']);
    assert.equal((await db.prepare("SELECT id FROM transactions WHERE kind LIKE 'chair_mfa_%'").all()).length, 0);
    await assert.rejects(assertAuthMutationVersion(db, 'chapter', 'chair', originalEpoch), error => error.status === 401);
    const pausedEpoch = await authMutationVersion(db, 'chapter', 'chair');
    const resumed = await setChairAccess({ db, memberId: 'chair', action: 'resume', confirmation: 'VERIFIED CHAIR HANDOFF' });
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.providerFactorChanged, false);
    assert.equal((await db.prepare('SELECT active FROM members WHERE id=?').get('chair')).active, 1);
    await assert.rejects(assertAuthMutationVersion(db, 'chapter', 'chair', pausedEpoch), error => error.status === 401);
    assert.equal((await db.prepare('SELECT id FROM members').all()).length, 2);
    assert.deepEqual((await db.prepare('SELECT action FROM audit').all()).map(row => row.action), ['account.chair.suspend', 'account.chair.resume']);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});
