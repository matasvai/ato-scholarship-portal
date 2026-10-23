# Operator runbook: Vercel and Supabase

This is the deployment procedure for the implemented private portal. A Vercel production deployment and Supabase project exist. The chapter-managed login screen is the live entry point. The Chair office account can be piloted before custom SMTP; member invitations and email resets require SMTP, and roster-sheet eligibility still requires acceptance testing. Canvas import is deferred.

`AUTH_MODE=chapter` selects the chapter-managed screen. It does not grant access by itself: the Supabase keys and exact Chair office account identity are required before sign-in activates.

The hosted architecture is Vercel's Node server entrypoint, Supabase PostgreSQL for application state, and a private Supabase Storage bucket for evidence. Local demo mode continues to use disposable SQLite and local fictional files. No member records or credentials belong in the repository.

## 1. Prepare the accounts and production boundary

Use the chapter's controlled Vercel and Supabase accounts. Import this repository into a Vercel project. Set Node.js **24.x**; the repository pins pnpm and the dependency lockfile. Set `ENABLE_EXPERIMENTAL_COREPACK=1` in the Production environment so Vercel honors the pinned pnpm version, including when the install command is overridden. The install command is `pnpm install --frozen-lockfile`, and the build check is `pnpm check`. `server.mjs` is the Node entrypoint; `vercel.json` sets a 120-second invocation limit. See [Vercel's Corepack configuration](https://vercel.com/docs/builds/configure-a-build#corepack).

The deployment configuration excludes local environment files, Vercel caches, Git metadata, test fixtures, and working data from dependency tracing as well as uploads. Keep both exclusion lists when changing the build: tracing a local Vercel cache can break packaging or include files that do not belong in the server bundle.

Browser assets live in `web/`. Do not rename that directory to `dist/`, `build/`, or `output/`: Vercel's Node builder searches those directories after the build command and can mistake the browser's `app.js` for the compiled server. Verify the packaged server handler and asset inventory after changing deployment settings; a successful build alone does not prove that the correct program was packaged.

The current project is deployed through the Vercel CLI from the linked workspace. Repository visibility does not configure automatic Git deployments; that is a separate Vercel project setting. Confirm the linked account and project before deploying, and complete the database, storage, and identity setup below first.

Choose the final HTTPS hostname first. Set `PUBLIC_ORIGIN` to that exact origin, such as `https://scholarship.example.edu`, without a path, query, or credentials. Register the same origin's identity and Canvas callback URLs. A different temporary hostname is not interchangeable with the configured origin.

Enter the placeholders from [.env.vercel.example](.env.vercel.example) in **Vercel's Production environment only**. Do not copy production secrets to Preview or Development. This application rejects Vercel Preview mode and refuses hosted SQLite/local-file fallback. A private Git repository, deployment protection, and `noindex` headers do not replace member authentication.

Keep database passwords, identity client secrets, Storage keys, Canvas secrets, the encryption key, and the roster service-account private key in the provider's server-side secret store. Do not paste them into chat, screenshots, committed files, frontend variables, or support logs. Redeploy after changing production environment values.

## 2. Create and migrate the private database

In Supabase's **Connect** dialog, copy the actual connection details; do not construct the pooler hostname from the region. Use the transaction-pooler connection on port **6543** for Vercel's `DATABASE_URL`. You can omit the password from that URL and enter the raw password separately as a Production-only Secret named `DATABASE_PASSWORD`; this avoids manual URL encoding. Alternatively, keep the password in `DATABASE_URL` with special characters URL-encoded. Set only one password source. The application uses one PostgreSQL connection per warm instance and unnamed parameterized queries. Supabase recommends transaction pooling for serverless applications. [Connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres)

The driver requires verified TLS. If the connection needs Supabase's database root certificate, set `DATABASE_CA_CERT` to that certificate's PEM text; literal `\n` line breaks are accepted. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`. `DATABASE_SSL=disable` is permitted only for explicit local loopback tests and is rejected in Vercel.

Run the migration deliberately from a trusted operator environment before the first production deployment:

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
```

The command reads `DATABASE_URL` and optional `DATABASE_PASSWORD` from that environment or a local ignored `.env`. For the migration, use a direct PostgreSQL connection when available, or the session pooler when the operator network requires it. Restore the **transaction** pooler URL in Vercel afterward. Never put a password-bearing connection string or raw password in the command text or shell history. The migration requires a database role allowed to create the schema and perform its grants/revokes. The server checks schema readiness on startup; it does not run production migrations on every request.

The migration creates the `scholarship_private` schema, enables deny-by-default Row Level Security on its tables, and revokes schema/table/sequence access from `PUBLIC` and, when present, Supabase's `anon` and `authenticated` roles. It applies matching default-privilege revokes. Keep this schema out of Supabase's exposed Data API schemas. The portal uses server-side SQL and ownership checks; these revokes do not restrict the privileged server database account itself. Do not add broad browser grants or public access policies to work around a configuration problem.

This migration creates an empty live chapter. It does not import existing Google Forms submissions, point totals, or proof files. An import requires a separate reviewed mapping; preserve the original sheets until that migration is explicitly performed and reconciled.

## 3. Configure private evidence storage

Create a **private** standard Storage bucket named `scholarship-evidence`, or choose another valid name and match `SUPABASE_STORAGE_BUCKET`. Set its file-size limit to exactly **5,242,880 bytes (5 MiB)** and its allowed MIME types to exactly:

```text
application/pdf
image/png
image/jpeg
```

Do not make the bucket public, and do not add anonymous or general authenticated-user upload/download policies. The portal issues narrowly scoped signed upload URLs after its own authorization. Hosted startup and Storage operations check the private flag, size limit, and MIME allowlist; a mismatch fails closed.

Set `SUPABASE_URL` to the project's exact `https://PROJECT_REF.supabase.co` origin. Prefer a server-only `SUPABASE_SECRET_KEY` (`sb_secret_...`), or use a legacy `SUPABASE_SERVICE_ROLE_KEY` with the `service_role` claim. Leave the unused alternative blank. Publishable/anonymous keys are rejected by this integration. New secret keys are sent only in the `apikey` header; legacy service-role JWTs also use the authorization header. [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)

The browser uploads directly to a random, member-bound quarantine path in Supabase. The portal then downloads the actual bytes server-side, checks the 5 MiB limit and PDF/PNG/JPEG signature, verifies the requested size/type, and writes those verified bytes to a separate immutable final key. Only the final record becomes usable proof. Filenames, browser metadata, and a successful upload response alone do not approve evidence or award points.

Authorized evidence downloads redirect to a signed attachment URL with a default **60-second** lifetime. Anyone holding that bearer URL can use it until it expires; logout or member deactivation does not revoke a URL already issued. Supabase upload grants last **two hours**, which is why reset cleanup accounts for outstanding grants. [Signed uploads](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl), [private downloads and signed-link lifetime](https://supabase.com/docs/guides/storage/serving/downloads)

Direct transfers keep 5 MiB proof files out of Vercel request and response bodies. Vercel's documented function payload ceiling is **4.5 MB**. This portal additionally refuses JSON and CSV responses larger than **4 MiB** with an error; it does not silently truncate them. Large histories/audits/exports therefore need pagination or a separate export implementation before expansion beyond the pilot. This is a limit, not a demonstrated capacity guarantee. [Vercel payload limits](https://vercel.com/docs/functions/limitations)

## 4. Set up chapter accounts and the Chair office account

The Scholarship Chair uses a chapter-controlled inbox, not a member's school or personal account. Set `CHAIR_ACCOUNT_EMAIL` to that inbox in Vercel Production. In Supabase Authentication → Users → Add user → Create new user, enter the office email and a strong password directly in Supabase, with **Auto confirm user** selected. Copy the new user's exact UID into the Production-only `CHAIR_AUTH_USER_ID` setting and redeploy. The first successful login of that exact pair creates the Chair role only if no Chair already exists. The account has no tier, credit load, or member points. Do not set a password in Git, chat, or Vercel environment variables.

At each Chair transition, use the [operator handoff procedure](docs/CHAIR-HANDOFF.md) to suspend access, transfer the chapter inbox, rotate the password, then resume the office account. Completing a reset revokes existing portal sessions. Because the account is shared across officeholders, the audit log identifies the office account rather than the individual person; record the handoff dates separately. Keep the inbox recovery access under chapter control.

### Legacy Microsoft setup (inactive)

For Microsoft Entra, register the approved university-tenant web application and configure:

- `MICROSOFT_TENANT_ID`: the exact tenant GUID.
- `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`.
- Callback: `https://YOUR_HOST/auth/microsoft/callback`.
- The optional **acct** ID-token claim. This implementation accepts `acct=0` and rejects guest/personal identities and missing membership claims.

Set `BOOTSTRAP_PROVIDER=microsoft` and `BOOTSTRAP_SUBJECT=TENANT_GUID:oid:OBJECT_GUID`, using the chair's verified directory object ID in the configured university tenant. `BOOTSTRAP_NAME` and `BOOTSTRAP_EMAIL` are display/contact metadata; neither determines who becomes chair. Do not derive the subject from a name, phone number, guessed university address, or the first visitor.

The first successful login of that exact identity creates the chair **only if no chair already exists**. Merely changing the bootstrap environment does not promote another account once a chair is present. Preserve a documented operator recovery procedure for the trusted roster and directory binding. The Microsoft fallback subject, if no `oid` is issued, is `TENANT_GUID:sub:SUBJECT`; verify the actual provider output before provisioning it. See [Microsoft ID-token claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).

Microsoft support remains in the code only as an explicit legacy mode. It is not the chapter's planned login.

### Invitation email wording

The editable template is `supabase/email-templates/invite.html`. Its subject is **Set up your ATO Scholarship Portal account**. It identifies the recipient’s email as their username and provides a one-time setup link; no temporary password is sent. Supabase fills `{{ .Email }}` and `{{ .ConfirmationURL }}` for each recipient. Do not substitute a real member’s link in Git or a public preview.

To install or update the template, open Supabase Authentication → Emails → Templates → Invite user, paste the subject and HTML, preview, then save. This repository file does not automatically update the hosted Supabase template. No email is sent by editing the template; sending an invitation is a separate Chair action. Verify the saved hosted wording and delivery with one explicitly authorized recipient before rollout.

After a successful password setup or email password reset, members sign in and receive their new 16-word key. They confirm saving it before entering the portal. A confirmed current key is retained on the next login; an unconfirmed, lost-response or consumed key can be replaced after authentication. The Chair office account does not receive a member key.

The password-reset template is `supabase/email-templates/recovery.html`, with subject **Reset your ATO Scholarship Portal password**. Install it separately in Supabase's **Reset password** template. Both templates contain only provider placeholders and the public portal address; neither contains a usable member setup/reset link. See the [member quick start and FAQ drafts](docs/MEMBER-GUIDE.md) for wording the Chair can share after review. No hosted template change or email send is performed by committing these files.

### Chapter-managed login pilot

The default `AUTH_MODE=chapter` uses Supabase Auth to verify email/password credentials and the portal's own membership database to authorize records. The chapter chair can invite a member, send a reset email, and deactivate access. Members may sign in using their verified email, assigned `KH-...` portal sign-in ID, or a chair-entered badge number. The immutable Portal Member ID remains the sheet eligibility key and never changes when a badge is assigned. No public self-registration or predictable temporary password is used.

Before enabling this mode, configure a custom SMTP sender in Supabase Auth and test delivery to an ordinary member address. Supabase's default sender is for limited testing and cannot deliver to arbitrary chapter members. Keep public signups disabled and email confirmation enabled. Set Supabase Auth's Site URL to the production origin and allowlist only `${PUBLIC_ORIGIN}/account/setup` and `${PUBLIC_ORIGIN}/account/reset` for this flow. The production project's current Site URL and these two redirect URLs have been configured; The inbox owner reported saving SMTP on September 30, 2026; delivery remains untested until an explicitly authorized test. [Supabase invitations](https://supabase.com/docs/guides/auth/users), [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

The chapter selected `scholarshipchair.kappaeta@gmail.com` as a temporary sender. In Supabase Authentication → Emails → SMTP Settings, use that address as sender and username, `ATO Kappa Eta Scholarship` as sender name, `smtp.gmail.com` as host, and a matching secure SMTP port: `587` for STARTTLS (the previously saved pilot setting), or `465` for implicit TLS. Do not change a working port solely to match this guide. The inbox owner must turn on Google 2-Step Verification and create a **separate App Password** for Supabase; enter that App Password directly in Supabase's password field, never the normal Gmail password. Save, then test an invitation and a reset to an authorized test address. Gmail is a pilot sender; plan to move to a verified chapter domain and transactional sender before inviting the full roster. [Google SMTP settings](https://support.google.com/a/answer/176600), [Google App Passwords](https://support.google.com/accounts/answer/185833), [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

`SUPABASE_PUBLISHABLE_KEY`, `CHAIR_ACCOUNT_EMAIL`, and `CHAIR_AUTH_USER_ID` are in Vercel Production. The confirmed Chair office user exists in Supabase Auth. Keep `SUPABASE_SECRET_KEY` server-side; the browser never receives it. The inbox owner reported saving custom SMTP; CHAPTER_EMAIL_READY is enabled in Production. No test email or roster invitation was sent during this setup. `CHAPTER_EMAIL_READY` defaults to false and disables invitations and email resets in the interface and server. After SMTP is configured, test delivery to an authorized address, set `CHAPTER_EMAIL_READY=true` in Vercel Production, and redeploy. Do not infer Chair identity from an email pattern or the first visitor.

The shared office account does not get a member recovery key, so keep chapter-controlled recovery access to its inbox. The Chair signs in with the office email and password, and can reset the password with a verified email link. Loss of inbox access requires the operator procedure. After SMTP and the read-only email roster are working, pilot with consenting members: confirm invite delivery, password setup, login by all assigned aliases, own-record isolation, chair-only controls, email and 16-word-key recovery, session revocation, deactivation, and semester key rotation. Member recovery keys require explicit saved-key confirmation. If the first key screen is lost or its key remains unconfirmed, a later authenticated login can issue a replacement. A valid key is retired before a password-provider update begins, so a timeout or interrupted database write cannot make that old key reusable. When an update's result is uncertain, wait two minutes as instructed, then try the new password, then the previous password, or use email reset; a successful login can issue a replacement key. These cases need live-provider acceptance even when local fault-injection tests pass. The live site's `/demo/` opens public fictional member and Chair views directly for showcasing both interfaces. This browser-only sandbox does not exercise Supabase Auth or the chapter database and must not be used as an authentication acceptance test.

## 5. Connect the read-only roster

The chapter's existing link-viewable sheet has `First Name` (A), `Last Name` (B), `Status` (C), `900 Number` (E), and `Student Email` (I). Ordinary eligibility refreshes read only A, B, C, and I through Google's CSV feed. The Chair's GPA import separately reads E for transient matching; 900 numbers are not saved in the roster snapshot. The portal never edits the sheet and needs no Google Cloud account, API key, or service-account secret. The Chair reviews each invitation; the portal prepares and binds the Supabase Auth account before requesting its setup email, and the verified Auth user ID remains the account binding. Preparing or checking an account alone does not send an email. The Chair office account is independent of this sheet.

Set these **Production** environment variables on the Vercel project:

```text
ROSTER_REQUIRED=true
ROSTER_SOURCE_MODE=public_email_csv
ROSTER_SHEET_ID=THE_ID_BETWEEN_D_AND_EDIT_IN_THE_SHEET_URL
ROSTER_SHEET_GID=0
```

Use only the ID, not the full URL. `ROSTER_SHEET_GID` is the number after `gid=` in the sheet link. The sheet must remain link-viewable for this public-export mode. The parser accepts `Active` and `New Mem.` (also `New Member`) in column C as eligible; every other status is ineligible. Eligible rows need a name and valid unique email. At most 1,000 rows are accepted. The portal requests only A, B, C, and I in one read, discards ineligible rows, and retains only eligible names/emails in the chapter database. Do not put actual roster rows in Git or Vercel environment variables.

After deployment, sign in as Chair → **Roster** → **Refresh roster now**. The page should show the eligible count, including new members, and a list of people ready to invite. Once chapter SMTP is tested and `CHAPTER_EMAIL_READY=true`, choose an eligible member, review the prefilled name/email, enter tier and credits, and send an invitation. A member's confirmed email must remain Active or New Mem. on the sheet to access the portal. The sheet is refreshed at most every 15 minutes; Chair can force a refresh. If the export becomes unavailable or its columns change, member access fails closed while Chair access remains available to repair the connection.

The older Portal Member ID integration remains available with `ROSTER_SOURCE_MODE=service_account_ids` (the default), `'Roster'!D1:E1002`, and Viewer service-account credentials. It requires adding IDs and active flags to an editable sheet. Do not configure both modes at once.

### Import GPA tiers as Scholarship Chair

The Chair downloads the GPA worksheet as **CSV** and opens **Roster → Import GPA tiers**. The source does not need to be shared with the portal developer or made public. Excel worksheets must first be saved as CSV; direct `.xlsx` uploads are not supported.

1. Choose the CSV. Set **Header row** and **First member row** to the spreadsheet's row numbers. Use header row `0` for a file without headers.
2. Choose separate first/last names or one full-name column. Select the column for each name field, previous-semester GPA, and optionally 900 number or email. Letters and header labels identify the columns, and a sample shows the chosen cells. **Match header names** can fill common labels automatically.
3. Optionally **Save layout for next time**. Only row numbers, column positions, and name format are saved; source cell values are not.
4. Select **Preview tiers**. Review every match and proposed tier. Exact 900 number and name matches are preferred; exact email/name or unique name matches are used when no number is supplied. Select a roster member manually or skip unresolved rows. Duplicate member selections and invalid GPAs block applying the batch. A changed layout clears the previous preview.
5. Check the review confirmation and **Apply reviewed tiers**. Existing active member goals update; eligible members without accounts receive a staged tier for their later invitation. No invitation is sent by this operation. A changed roster, semester, or tier snapshot requires a new preview.

The page-5 ranges are authoritative: 3.50+ → Tier 1; 3.00–3.49 → Tier 2; 2.70–2.99 → Tier 3; 2.50–2.69 → Tier 4; below 2.50 → Tier 5. New members use Tier 1. GPA comparisons use the original value without rounding.

The CSV is read in the Chair's browser. Only roster emails and resulting tiers are sent in the apply request; raw GPAs, 900 numbers, and the file are not saved by the portal. Import API activity is redacted. Closing the dialog removes the preview and source cells from the page. Semester reset clears staged tiers, retains column layout settings, and preserves existing member accounts and their current tiers for the Chair to review. The **Edit** control beside an active member's tier can adjust tier and enrolled credits without entering a GPA.

### Manage class syllabi

Members open **My profile → My classes → Add class**, enter a class name, and upload a PDF, PNG, or JPEG syllabus (up to 5 MB). Existing saved class names appear as **Syllabus needed** and need an upload and review; they are not automatically approved. The Chair opens **Syllabi**, expands a class to view its file, and approves it or denies it with a reason. Only approved classes can be selected for major, minor, lab, or other grade-scored submissions. The server enforces this restriction; non-graded activities remain available.

Each new graded submission records the syllabus version used at submission time. Expand **Class syllabus** in the assignment details to view it alongside the assignment evidence. Replacing a syllabus requires fresh approval before further graded submissions; removing a class prevents further graded submissions for it. Both actions preserve syllabus references on existing assignments. Older submissions without a reference remain unchanged.

Access is limited to the member who uploaded the syllabus and the Chair. Semester reset clears class records, syllabus versions, and their files using the existing evidence deletion process. It does not erase separately retained backups or downloaded copies. The browser sandbox uses fictional files in tab-session storage, limited to 1 MB each. No additional provider credentials or database schema migration are required for this feature.

Before rollout, use fictional documents to check pending and denied classes cannot submit graded assignments, approval unlocks them, another member cannot retrieve the syllabus, and replacement/removal preserves an existing assignment's original reference. Check both PDF and image previews on the browsers members will use. These checks do not send invitations.

### Maintain the shared FAQ

Sign in as Scholarship Chair and open **FAQ → Add question**. Enter plain-text question and answer, then choose **Save for all members**. Each question expands separately. The Chair can expand an item to edit or remove it; removal asks for confirmation. Members can read the entries but cannot change them. Changes persist between semesters. Simultaneous edits require the stale editor to reload before saving. The public `/demo/` uses the same controls with fictional, browser-local records; its FAQ changes do not change the chapter FAQ.

## 6. Optional Canvas connection

Canvas requires the institution's OAuth developer key, not personal access tokens pasted by students. Set the exact HTTPS `CANVAS_BASE_URL`, client ID/secret, and callback `https://YOUR_HOST/auth/canvas/callback`. Enable **Allow Include Parameters** and these read scopes:

```text
url:GET|/api/v1/courses
url:GET|/api/v1/courses/:course_id/assignments
```

Generate `APP_ENCRYPTION_KEY` as 32 random bytes encoded in base64 and store it as a stable server secret. Back it up separately from the database. Changing or losing it makes previously encrypted Canvas tokens unreadable. Each member authorizes their own Canvas account separately from university portal sign-in. Imports are pending claims; the chair still verifies the activity category and awards points. Leave Canvas configuration blank until its registration is approved.

## 7. Change semesters and permanently clear live academic records

Use the chair's **Semester** screen. Enter the next semester's name, start date, three checkpoint dates, final target date, and submission closing date. Dates must be ordered; no checkpoint dates are guessed. Tier point targets stay unchanged. Claims for dates before the new start are rejected once that semester activates.

Review the old semester and deletion counts, then type `DELETE SEMESTER`. The preview token expires after ten minutes and binds the exact records shown; a changed or expired preview must be refreshed. Starting the reset immediately removes old submission/evidence access and freezes new academic writes. Member accounts, stable identity bindings, and account/security audit events remain. Old submission, evidence, class, syllabus, and Canvas-import audit details are removed.

The deletion job persists the planned quarantine and final object keys before withdrawing access. **Resume cleanup** processes one object per request and keeps issuing bounded requests while work is available. It stops when finished, waiting, interrupted, or unable to verify deletion. Each object requires verified absence before it is counted as deleted. Provider failures keep the job incomplete and retryable; a terminated worker's lease expires after two minutes. Refreshing/redeploying does not discard the inventory. There is no automatic background scheduler in this version: return to the chair screen and resume when its next-attempt time arrives.

Hosted final files wait at least **five minutes after reset starts** to drain bounded in-flight finalizers. Recent quarantine grants, including grants for already-finalized files, wait until their two-hour lifetime plus five-minute grace has elapsed. The UI may therefore show a hold of up to approximately **two hours and five minutes**. New-semester submissions open only after every planned file deletion is verified. Do not bypass the hold, delete the manifest by hand, or report a partially finished reset as complete.

This is permanent deletion of **live application records and current Storage objects**. It does not immediately destroy previously retained provider backups, database point-in-time history, independent exports, or a user's downloaded copy. Document their retention periods separately; do not promise that this button erases those copies.

## 8. Backups, recovery, and the live acceptance gate

Use the [launch checklist](docs/LAUNCH-CHECKLIST.md) for the Chair meeting and pilot sign-off, and the [backup and restore runbook](docs/BACKUP-RESTORE.md) for operational ownership, inventory and retention. Run `node scripts/rehearse-operations.mjs` for a repeatable fictional backup/restore and interrupted-cleanup rehearsal. It verifies database and actual evidence bytes and removes its temporary files; it does not configure production backups or contact any provider.

Back up three separate things under chapter-controlled access: the application database, actual private Storage object bytes, and `APP_ENCRYPTION_KEY` plus the server-secret recovery material. Supabase database backups contain Storage metadata but **not the object bytes**. Test restoration in an isolated project. [Supabase backup scope](https://supabase.com/docs/guides/platform/backups)

Record retention and destruction schedules for each backup/export location. A restore from before a completed semester wipe can resurrect old academic records; reapply the intended deletion policy before allowing member access. Resume incomplete purge jobs from their retained manifests. Preserve the encryption key alongside the matching encrypted-token database version; replacing it is not a transparent token migration.

Before accepting real academic documentation, run a fictional pilot on the actual production-shaped deployment:

1. Sign in to the dedicated Chair office account using its exact Supabase Auth user ID and email. Verify that an unknown account, a wrong password, and an unbound Auth user cannot become Chair. Add a second factor for Chair access before storing real academic evidence; test its enrollment and office-transition recovery.
2. After custom SMTP is working, invite two fictional members and verify invitation delivery, password setup, sign-in by email and each assigned alias, password reset, and revocation of old portal sessions. Test a member whose invitation must be resent or corrected.
3. Confirm each member can see only their own records and cannot access the other member's direct submission/evidence URLs; verify chair-only review and CSRF rejection.
4. Verify the current roster's exact email matches, Active/New Member inclusion, inactive/removal behavior, stale-refresh failure, Chair repair access, and reactivation. If using legacy explicit-ID mode, verify its boolean eligibility column separately. Keep `ROSTER_REQUIRED=true` in Vercel Production before inviting members.
5. Upload/download PDF, PNG, and JPEG evidence directly; test exactly 5 MiB, over-limit rejection, foreign access denial, grant replay, immutable final proof, and actual provider absence checks.
6. Submit, approve, deny with a reason, repeat an import, and confirm pending/rejected work never inflates approved totals. If Canvas is enabled, test university consent and a released zero grade as well as ordinary grades.
7. Interrupt a fictional reset mid-cleanup, resume after its holds/lease, verify both quarantine and final objects are absent, and confirm accounts remain with an empty new semester.
8. Restore a fictional database/object backup into an isolated environment and verify the matching encryption key and deletion-retention procedure.

Local and provider-mock tests support the implementation, but do not establish live Supabase semantics, Vercel interruption recovery, email delivery, or operational capacity. Keep the pilot small until those checks pass. Never use real academic records for a reset test.

### Controlled invitation rollout

Production CHAPTER_EMAIL_READY was enabled on September 30, 2026 after the user confirmed SMTP setup. Delivery has not been tested. Chair → Chapter roster → Refresh roster now lists eligible, uninvited active and new members. Search or filter recipients, choose Review invitation, check the address/tier/credits, and confirm the second screen to send one setup link. Refreshing/importing the roster never sends invitations. Do not send rollout or test messages until explicitly authorized. New unconfirmed accounts use Supabase Auth’s Invite user template; confirmed accounts receive a link using its Reset password template. Review and install both templates before testing delivery.

Account preparation is saved before a setup email is requested: the portal reserves the member/sign-in alias, creates an unconfirmed Auth identity without email, and durably binds the identity and member before sending. If preparation is interrupted, **Check account setup** resumes or reconciles the exact email binding and never sends a message. An existing orphan Auth account can be repaired through that check only when its identity is confirmed or its trusted provider metadata proves this portal prepared it; other unconfirmed accounts require operator review. **Send setup email / Resend setup email** is a separate explicit Chair action with a 60-second cooldown. A timeout after sending means delivery is unknown, not that nothing was sent; inspect the inbox before resending. No background retry sends an email automatically. The setup status distinguishes preparation, ready, accepted by the email service, and unknown delivery. Confirmed Auth users receive a recovery link targeting the same setup page; unconfirmed users receive the invitation flow. These intents are stored with chapter state and survive semester reset; no new credentials or migration are required.

### Chair sign-in and officer transitions

Production Chair access uses the office email and password. The portal no longer enrolls, challenges, or requires an authenticator. The existing active-account checks, exact Supabase identity binding, role authorization, CSRF protection, password-attempt limits, and password-reset/session-revocation guards remain in force. Members keep their ordinary chapter login.

Previously enrolled Supabase factors are left unchanged. They do not block portal password sign-in. For password setup/reset, the server verifies the provider token and its exact active portal identity before updating the password; a legacy-factor account uses a server-side password update for that verified identity because Supabase otherwise requires elevated assurance for a token-based update. No factor is added or removed, no session is granted by reset, and existing portal sessions are revoked. Old pending authenticator cookies cannot grant access and are cleared on successful password login. No schema migration or new environment variable is required.

At a Chair transition, a trusted project operator must verify the authorized officeholder and use the [operator handoff procedure](docs/CHAIR-HANDOFF.md) to pause the account, transfer chapter inbox access, rotate the office password, and resume the same account. Changing provider credentials alone does not revoke the portal's independent sessions. Keep passwords and inbox recovery material outside Git/chat. Test real password login, email reset, and handoff with an authorized pilot before accepting real academic evidence.

The repository's reset email template no longer mentions an authenticator. Install the updated `supabase/email-templates/recovery.html` in Supabase before sending reset/setup emails; editing the repository alone does not update the hosted email template.

### Points earned before rollout

In the Chair view, open **Member points → Adjust points** beside a member. Enter the **new approved total**, including existing approved submissions plus points earned before the portal, and a reason. For example, if the portal shows 5 and the member earned 20 elsewhere this semester, enter 25. The preview shows the difference before saving. To correct a mistake, enter the corrected total and a new reason.

Adjustments are stored as a separate semester ledger; submission awards and approved-submission counts are preserved. These are final points, so credit-load multipliers are not applied again. Members can read their own breakdown and reasons through **Point details**, while only the Chair can change totals. Each adjustment records its previous/new total, difference, actor, and timestamp. Stale or repeated submissions are rejected; the form must be reopened after another adjustment, approval, or semester change. Starting a new semester removes the adjustment ledger and related academic audit entries. The public sandbox implements the same workflow in tab-session storage only. No database schema migration is required.

### Founder pilot accounts

Chair → Roster → Create pilot accounts provisions three real Supabase password accounts: glazebrook (Tier 1), marshall (Tier 3), ross (Tier 4). The server generates independent random passwords, returns them once, and stores only ordinary Supabase authentication credentials; plaintext passwords never enter application state or audit logs. Save the displayed credentials privately. Reserved `@pilot.invalid` addresses are internal identifiers, not inboxes; creation and password-reset requests send no email. Members can use their first-login recovery keys.

Only the exact Chair-created member IDs receive a roster exemption for 30 days. Inactive accounts are blocked immediately; expiry is checked on authenticated requests. No domain-wide exemption applies. These are production pilot records, visible to the Chair and included in member totals; they are not session-only demos. The Chair may adjust tiers, credits, points, or deactivate them. Semester reset may end pilot access when it clears the pilot state. Do not use these accounts for real members. A second creation request fails instead of duplicating accounts or exposing passwords again.

Before chapter-wide invitations: verify the hosted Supabase Invite template and redirect URL; explicitly authorize one recipient to test delivery, setup, reset, sign-out and a fresh sign-in; verify roster email matching, new-member inclusion, assigned tiers, credit loads and actual checkpoint dates; test a private evidence submission through Chair review and confirm another member cannot access it. Invite a small group before the remaining roster. SMTP being configured is not proof of delivery. No invitation is sent merely by refreshing the roster or editing member settings.

Signed-in chapter members and the Chair can change their password under My profile. The current password is verified against the exact linked Supabase identity; the new password must match its confirmation and contain at least 12 characters. The endpoint requires origin/CSRF checks, rate limits attempts, and revokes all portal sessions on success. Existing recovery keys remain valid. Public session-only demo passwords are unchanged.
