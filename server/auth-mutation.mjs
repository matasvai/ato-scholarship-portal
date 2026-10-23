import { createHash, randomBytes } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');

const authMutationId = (workspace, memberId) => hash(`auth-mutation:${workspace}:${memberId}`);
export async function authMutationVersion(db, workspace, memberId) {
  const row = await db.prepare("SELECT data FROM transactions WHERE id=? AND kind='auth_mutation'").get(authMutationId(workspace, memberId));
  const state = row ? JSON.parse(row.data) : { epoch: 'initial', busyUntil: 0 };
  if (state.busyUntil > Date.now()) fail(409, 'An account security update is in progress. Try signing in again shortly.');
  return state.epoch;
}
export async function assertAuthMutationVersion(db, workspace, memberId, expected) {
  if (await authMutationVersion(db, workspace, memberId) !== expected)
    fail(401, 'Account security changed during sign-in. Sign in again.');
}
// Caller holds the chapter lock in a committed transaction before calling the
// external password provider. Epochs remain after completion so in-flight old
// password attempts cannot issue fresh sessions after the reset.
export async function beginAuthMutation(db, workspace, memberId) {
  await authMutationVersion(db, workspace, memberId);
  const epoch = token();
  await db.prepare("INSERT INTO transactions(id,kind,session_id,data,expires) VALUES (?,'auth_mutation',NULL,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires=excluded.expires")
    .run(authMutationId(workspace, memberId), JSON.stringify({ epoch, busyUntil: Date.now() + 120_000 }), 253402300799000);
  await db.prepare('DELETE FROM transactions WHERE session_id IN (SELECT id FROM sessions WHERE workspace=? AND member_id=?)').run(workspace, memberId);
  await db.prepare('DELETE FROM sessions WHERE workspace=? AND member_id=?').run(workspace, memberId);
  // Compatibility cleanup for pending sign-ins created before MFA was removed.
  await db.prepare("DELETE FROM transactions WHERE kind='chair_mfa_pending' AND session_id=?").run(memberId);
  return epoch;
}
export async function finishAuthMutation(db, workspace, memberId, epoch) {
  const id = authMutationId(workspace, memberId);
  const row = await db.prepare("SELECT data FROM transactions WHERE id=? AND kind='auth_mutation' FOR UPDATE").get(id);
  if (!row) return;
  const state = JSON.parse(row.data);
  if (state.epoch !== epoch) return;
  await db.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify({ epoch, busyUntil: 0 }), id);
}
