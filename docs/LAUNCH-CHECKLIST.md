# Launch checklist

This is a working acceptance checklist, not a claim that version 1.0 is approved. Keep member emails, grades, passwords, recovery keys and private backup paths out of this public repository. Record the Chair's real decisions and test-recipient addresses in a chapter-controlled location.

## Bulk invitation controls — October 30, 2026

- 247 automated tests passed without failures or skips, including isolated PostgreSQL and first-invitation replay, concurrency, role, eligibility, rate-limit and interruption checks.
- A fictional Chair browser session selected two prepared accounts, reviewed one recipient list, and completed the batch against a fake email provider. Both accounts then became unavailable for bulk selection. Browser errors were empty. No real email was sent.
- Previous or uncertain sends and confirmed accounts cannot be bulk-selected. A definite provider rate-limit rejection requires a later manual selection; it cannot turn a previously uncertain send into a new first invitation.
- Before a full rollout, check the actual Supabase and SMTP email allowances and complete the authorized inbox test below. Follow the [bulk invitation steps](EMAIL-ROLLOUT.md#send-several-invitations-with-one-review).

## Excel imports and no-email roster editing — October 30, 2026

- 230 automated tests passed without failures or skips, including isolated PostgreSQL, account preparation/editing, student-ID validation and Excel workbook tests.
- Fictional browser checks opened both `.xlsx` and `.xls` files, selected a different worksheet, rebuilt its column mapping, required a new confirmation, skipped an invalid student-ID row, and applied only the reviewed tiers. Numeric GPA 2.699 stayed 2.699 even when Excel displayed 2.70; exact student IDs survived scientific display formatting. No workbook was uploaded.
- With email sending disabled, the Chair prepared an account and edited a member’s name and tier from Roster. The new-member preparation form kept Tier 1 locked. The provider fixture recorded zero mail attempts. Account changes preserve the permanent portal ID and use separate explicit sending controls.
- Invalid or duplicate student IDs affect only their own import rows. “900 number” does not require a literal 900 prefix. Correct source roster errors before importing affected members.
- These checks use fictional data and mocked providers. Real inbox delivery, physical iPhone acceptance, and the remaining Chair policy decisions below are still outstanding.

## Email template maintenance — October 25, 2026

- The hosted Supabase reset template was updated to remove the old authenticator instruction, then saved, reloaded and previewed. No emails were sent. Inbox delivery and completion of a real setup/reset flow still require an explicitly authorized recipient test.

## Password-only Chair login and GPA layout — October 23, 2026

- 202 automated tests passed without failures or skips, including isolated PostgreSQL checks. Authenticator enrollment and challenges were removed at the chapter's request; role checks, password verification, CSRF, rate limits and session revocation remain.
- A fictional browser session signed in directly as Chair, selected reordered GPA and 900-number columns, rejected a duplicate column mapping, saved the layout and applied the correct tiers to two fictional roster entries. No invitations were prepared or sent. The form had no page-level horizontal overflow at the browser's 533-pixel width; physical mobile-browser acceptance remains outstanding.
- Provider mocks cover password changes and resets for accounts with and without previously enrolled factors. Real Chair sign-in/reset still requires acceptance testing. The updated recovery-email source was subsequently installed in Supabase on October 25; future repository changes still require a separate hosted template update.

## Pre-meeting verification — October 11, 2026

- 200 automated tests passed, with no failures or skips, using SQLite and an isolated PostgreSQL instance. Source/deployment-file checks and the production dependency audit passed.
- Fictional browser checks covered Chair verification, incorrect-code rejection, resuming verification after reload, direct sign-out, member recovery-key acknowledgment after an interrupted first login, and account repair without sending mail. The Chair verification and member profile layouts were checked at 390 pixels wide.
- The operational rehearsal passed all six backup, restore, interrupted-wipe and retention checks using disposable records and actual fictional file bytes.
- Class-hour API and sandbox checks cover approval, denial, replacements, removals, stale/concurrent reviews, total limits and recalculated pending point estimates. A fictional browser flow verified approval to 3 hours, preserved hours during a removal request, and 0 hours after Chair approval. Class forms fit the 390-pixel layout.
- File previews retain a centered loading cross through image transfer and decoding, omit displayed filenames and support retry. Delayed/cached images and mobile layout were checked. The in-app browser’s PDF fallback was checked; native inline PDF rendering and physical Safari still require acceptance testing.
- Invitation and password-reset email templates were installed in Supabase, previewed, and verified after reloading the settings. Saving templates sent no emails; recipient inbox delivery remains untested.
- These checks used local provider mocks. They do not establish hosted email delivery, real Chair password login/reset, physical iPhone behavior, or production backup/restore readiness. Those remain explicit acceptance items below. No real invitation or reset email was sent during this work.

## Work that does not require the Chair

- Run the automated suite with an isolated PostgreSQL database as well as local SQLite. Include role/ownership checks, syllabus approval, scoring, stale edits, invitations, password recovery and Chair sign-in.
- Run `node scripts/rehearse-operations.mjs`. It must report all checks passing and remove its temporary data. It includes actual evidence-file bytes, interrupted deletion, account retention and restoring a backup taken before a wipe.
- Exercise member and Chair screens with fictional data on a narrow screen. Check native activity/class selection, image/PDF upload and preview, cropping, long file names, keyboard navigation, error/retry states, sign-out and loading indicators. Browser emulation does not prove Safari on a physical iPhone.
- Prepare and preview the [invite template](../supabase/email-templates/invite.html) and [reset template](../supabase/email-templates/recovery.html). Installing either template is separate from sending an email.
- Prepare eligible accounts and correct member details through **Roster** without sending an invitation. Follow the [email rollout guide](EMAIL-ROLLOUT.md); the existing roster is the recipient list, so no duplicate mailing list is needed in Supabase or Vercel. Use **Account setup & emails** to distinguish a prepared account from an email accepted by the provider.
- Review the [member instructions and FAQ drafts](MEMBER-GUIDE.md). Do not replace Chair-edited live FAQ entries automatically.
- Agree who will operate backups and restore the service, using the [backup runbook](BACKUP-RESTORE.md). A completed rehearsal does not mean scheduled production backups exist.

## Chair meeting: decisions and access

1. **Account and inbox.** Verify the dedicated Chair office login, chapter control of its inbox, password reset and a documented transition/recovery process. The previous officeholder's access must end at handoff. Never share the password in a meeting note or chat.
2. **Semester.** Confirm semester name, start date, three checkpoint dates, final point deadline and submission closing date. Preview all dates in the portal before saving; do not use semester reset merely to adjust a deadline if real records should remain.
3. **Roster.** Refresh the read-only sheet, confirm active and new members, detect duplicates/mistyped emails, and review deactivated access. Prepare the desired accounts and use **Manage member** to review names, badges, tiers and credits. Refreshing the roster, preparing accounts and saving member settings do not send invitations. A sign-in email correction needs a reviewed identity change; it cannot be made as an ordinary profile edit.
4. **Tiers and credits.** The Chair imports their private GPA Excel workbook or CSV, selects its worksheet and maps its rows/columns, reviews matches and resulting tiers, and applies them. Use the page 5 policy. The portal stores tiers rather than the source GPA sheet or 900 numbers. Members submit credit hours with each class syllabus, and the Chair approves both in **Classes**. Check all classes before reviewing point claims: the first class-hours approval replaces any old manually entered total with the sum of approved classes. Confirm any points earned before rollout.
5. **Rules.** Confirm point categories, checkpoint quotas, evidence requirements and syllabus approval before graded assignments. Confirm who will review submissions and handle denials/corrections.
6. **Privacy and retention.** Choose who can access operational backups, how long backups remain, when old exports are destroyed, and who is responsible for recovery. Semester reset removes live academic records and uploaded files; separately retained backups/downloads follow their own retention schedule.
7. **Pilot recipients.** Select two or three consenting testers with inboxes they control. Separately authorize one invitation and password-reset email test before any bulk rollout. No recipient is implicitly authorized by appearing in the roster.

## Pilot acceptance

Use fictional academic records with the actual hosted workflow. Record pass/fail and the deployed commit privately; do not paste setup links or tokens in screenshots.

- [ ] One authorized recipient receives the invitation with the correct sender, wording and site link; check spam as well as inbox.
- [ ] Preparing and editing another fictional pilot account sends no email. Its permanent sign-in ID stays unchanged after a badge edit, and the old badge no longer signs in.
- [ ] Recipient chooses a password, saves/acknowledges their recovery key, signs out and signs in again with supported aliases.
- [ ] Expired, interrupted and repeated setup/recovery attempts have clear recovery paths; old sessions cannot retain access after a password reset.
- [ ] The authorized recipient's reset email arrives and completes successfully. The Chair can sign in with the office email and password.
- [ ] A member adds a class with credit hours and a syllabus; a pending or denied syllabus blocks graded assignments. Chair approval unlocks the class and updates the account total. Pending replacements and removal requests preserve the previously approved hours until reviewed. Verify the resulting credit-load multiplier before approving point claims.
- [ ] A member submits fictional evidence; the Chair sees the file and original syllabus inline, approves or denies, and the member sees the correct notes and totals.
- [ ] The other member cannot open the first member's direct submission, syllabus, profile-picture or evidence URLs.
- [ ] Test on a physical iPhone/Safari: dropdowns, file picker/camera, portrait/landscape, dialogs, previews and sign-out. Also test desktop.
- [ ] Restore a separate fictional hosted database/object backup in an isolated project; confirm authentication bindings, encryption material, files and post-wipe retention rules. Never run a wipe test against the chapter's live data.
- [ ] Confirm production error monitoring and an operator contact, working backup schedule, and a tested previous-deployment rollback route.

## Version 1.0 decision

Invite the small pilot first. Resolve failed checks, have the Chair accept the policy/date/roster settings, then authorize the remaining invitations in batches compatible with the actual sender limits. Keep a way to pause sending and deactivate mistaken accounts. SMTP configuration and a successful deployment alone do not establish delivery or launch readiness.
