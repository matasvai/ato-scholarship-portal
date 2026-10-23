// Trusted database operator only. Never called by a portal route or browser.
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../server/database.mjs';
import { beginAuthMutation, finishAuthMutation } from '../server/auth-mutation.mjs';

const fail = message => { throw Object.assign(Error(message), { operatorSafe: true }); };
export async function setChairAccess({ db, memberId, action, confirmation }) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(memberId || '')) fail('Use the exact Chair member ID from inspect.');
  if (!['suspend', 'resume'].includes(action)) fail('Choose suspend or resume.');
  if (confirmation !== (action === 'suspend' ? 'SUSPEND CHAIR' : 'VERIFIED CHAIR HANDOFF')) fail('The explicit confirmation phrase does not match the requested action.');
  return db.transaction(async () => {
    const chapter = await db.prepare('SELECT data FROM chapters WHERE workspace=? FOR UPDATE').get('chapter');
    if (!chapter) fail('Chapter workspace was not found.');
    const chair = await db.prepare('SELECT id,role,active FROM members WHERE workspace=? AND id=?').get('chapter', memberId);
    if (!chair || chair.role !== 'chair') fail('That member ID is not a Chair office account.');
    if (action === 'resume' && chair.active !== 0) fail('Suspend this Chair account before performing a verified handoff.');
    const epoch = await beginAuthMutation(db, 'chapter', memberId);
    // Revoke sessions and any legacy pending sign-in, then change the epoch
    // under the same chapter lock used by password completion.
    await db.prepare('UPDATE members SET active=? WHERE workspace=? AND id=?').run(action === 'resume' ? 1 : 0, 'chapter', memberId);
    await finishAuthMutation(db, 'chapter', memberId, epoch);
    await db.prepare('INSERT INTO audit(workspace,at,actor,action,subject,detail) VALUES (?,?,?,?,?,?)').run(
      'chapter', new Date().toISOString(), 'Trusted project operator', `account.chair.${action}`, memberId,
      action === 'suspend' ? 'Chair access suspended; all portal sessions and legacy pending sign-ins revoked.' : 'Operator confirmed office handoff; Chair access resumed with old sessions revoked.',
    );
    return { memberId, status: action === 'suspend' ? 'suspended' : 'active', portalSessionsRevoked: true, providerFactorChanged: false };
  });
}

async function cli() {
  const [action, memberId, confirmation, ...extra] = process.argv.slice(2);
  if (extra.length || !['inspect', 'suspend', 'resume'].includes(action) || (action === 'inspect' && (memberId || confirmation))) {
    fail('Usage: node scripts/chair-access.mjs inspect | suspend MEMBER_ID "SUSPEND CHAIR" | resume MEMBER_ID "VERIFIED CHAIR HANDOFF"');
  }
  if (!process.env.DATABASE_URL) fail('Use an explicitly selected database environment file. DATABASE_URL is required; local fallback is disabled.');
  const db = await openDatabase({ env: process.env });
  try {
    if (action === 'inspect') {
      const chairs = await db.prepare("SELECT id,name,email,active FROM members WHERE workspace=? AND role='chair'").all('chapter');
      console.log(JSON.stringify({ chairs }, null, 2));
    } else {
      const result = await setChairAccess({ db, action, memberId, confirmation });
      console.log(JSON.stringify(result));
      console.log(action === 'suspend'
        ? 'Chair sign-in is paused. Members remain active. Verify the authorized officeholder and rotate office/inbox credentials before resuming.'
        : 'Chair access resumed. The incoming Chair can sign in with the office email and updated password.');
    }
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await cli(); }
  catch (error) {
    console.error(error.operatorSafe || error.status === 409 ? error.message : 'Chair access operation failed. No credentials were printed. Check the selected database and retry safely.');
    process.exitCode = 1;
  }
}
