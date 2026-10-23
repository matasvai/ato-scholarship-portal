# Chair account recovery and handoff

For a trusted project operator with database and Supabase administration access. Ordinary members and the Chair cannot run this through the portal. First verify that the chapter authorizes the incoming officeholder or account recovery. The portal uses the office email and password; no authenticator is required.

The pause below is reversible and only suspends the selected Chair office account. It signs that account out everywhere and blocks new Chair sign-ins until the operator resumes it. Ordinary members remain active, and academic records are preserved. Arrange this with the Chair; do not pause a live account as a test.

## Procedure

1. Prepare a private, explicitly selected environment file containing the correct database configuration. Keep it out of Git, logs and chat. Inspect the target project/environment before any mutation. These examples use a placeholder path; do not paste a database password into the command line.

   ```sh
   node --env-file=/secure/path/portal.env scripts/chair-access.mjs inspect
   ```

   This read-only command lists Chair member IDs, names, emails and active status. Verify the exact office account and select its **portal member ID**, not an Auth UID, name or email. The script requires PostgreSQL configuration and has no local-data fallback.

2. Pause that exact account with the displayed member ID:

   ```sh
   node --env-file=/secure/path/portal.env scripts/chair-access.mjs suspend MEMBER_ID "SUSPEND CHAIR"
   ```

   Proceed only after the result says `suspended` and `portalSessionsRevoked: true`. The transaction locks chapter state, marks the account inactive, revokes its sessions and any legacy pending sign-in, and changes its sign-in generation so an earlier password request cannot complete afterward. A concurrent security update may require waiting before retrying. Do not change credentials if the pause failed.

3. While suspended, use trusted Supabase administration to rotate the office account password for the exact bound Auth user, and hand over the chapter inbox/recovery access. The suspended account cannot complete a normal portal reset link; this intentionally prevents a self-service bypass. The script does **not** remove provider factors, reset passwords, email anyone or modify the chapter roster. Do not delete/recreate the Auth user: its stable binding must remain intact.

4. After verifying the chapter-approved handoff and provider changes, explicitly resume the same member ID:

   ```sh
   node --env-file=/secure/path/portal.env scripts/chair-access.mjs resume MEMBER_ID "VERIFIED CHAIR HANDOFF"
   ```

   Resume requires an already suspended Chair account, revokes any stale sessions again, and changes the sign-in generation. After resuming, the incoming Chair signs in with the office email and updated password.

5. Have the incoming Chair sign in privately with the new password and open the Chair view. Confirm that the old password/session no longer works. Record the handoff date and responsible operator privately. Store inbox recovery material under chapter control; do not share it in the audit note or chat.

If the process is interrupted, leave the Chair suspended while diagnosing it. `inspect` is safe to repeat. If a legitimate handoff is canceled without provider changes, the trusted operator can explicitly resume after verifying the current Chair.

## Local verification

`node private-tests/operations-chair-access.test.mjs` exercises the exact pause/resume function against a disposable fictional database. It checks wrong-ID/confirmation rejection, member access preservation, session/legacy-pending-sign-in revocation, stale sign-in rejection and audit events. No real Chair account was paused or modified during development. Real password rotation, inbox handoff, and incoming-Chair sign-in still require an authorized acceptance test.

For an ordinary forgotten password, request an email reset and choose a new password through its verified link. This does not change any legacy provider factor and does not sign the account in automatically. If the chapter has lost control of the inbox, use the trusted operator procedure instead.
