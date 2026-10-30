# Member account and email rollout

The portal's **Roster** page is the recipient list. Do not upload a second mailing list into Vercel or Supabase. The connected sheet supplies eligible active and new members; the Chair reviews their accounts in the portal. The sheet is read-only to the portal.

## What each service does

| Location | Responsibility |
| --- | --- |
| Chapter roster sheet | Names, membership status and the correct school email for each member. |
| Portal → Roster | Review eligibility, prepare accounts, edit member details and explicitly send a setup email to a chosen person. |
| Supabase Authentication | Store sign-in identities and passwords; send setup and password-reset links through the configured SMTP sender. |
| Supabase Authentication → Emails | Sender/SMTP settings and the hosted invite/reset templates. |
| Supabase Authentication → URL Configuration | Production site address and allowed setup/reset destinations. |
| Vercel → Project Settings → Environment Variables | Server configuration and the switch that enables email actions. No recipient addresses or email password belong in application source code. |

## Prepare the list without emailing anyone

1. Sign in as the Scholarship Chair and open **Roster**.
2. Refresh the roster. Correct missing, duplicate or mistyped school emails in the source sheet, then refresh again. Include both active members and new members.
3. Import the GPA file, select its GPA and 900-number columns, and review the proposed matches and tiers. The source GPA and 900 numbers are used temporarily for matching; the portal retains the assigned tier.
4. Choose **Prepare account**, review each name, optional badge number and tier, then **Save without sending email**. Members without a badge receive a separate portal sign-in ID. Review prepared accounts under **Account setup & emails**.
5. Use **Manage member** to correct existing account details. Saving member details and checking account setup are separate from sending a setup email.

For a new member, account preparation creates and binds an unconfirmed sign-in identity without a password email. It is not evidence that the member has received anything or can already sign in. An interrupted preparation can be checked and resumed without sending mail. Avoid using a 900 number as a badge or portal username. The sign-in email is read-only in account settings: changing it requires a separate reviewed identity update because it binds the account to the roster and Supabase.

## Before the first authorized email

- Confirm the chapter controls the sender inbox and its recovery access. The SMTP password is a dedicated Google App Password entered privately in Supabase, not the normal inbox password.
- Review both hosted email templates against [invite.html](../supabase/email-templates/invite.html) and [recovery.html](../supabase/email-templates/recovery.html). Editing these files in Git does not install them in Supabase. Saving a template sends no email.
- Confirm the production Site URL and the exact `/account/setup` and `/account/reset` redirect URLs. Keep public signups disabled and email confirmation enabled.
- Confirm `CHAPTER_EMAIL_READY=true` in Vercel Production and deploy any configuration change. This switch means sending is enabled; it does not prove SMTP delivery works.
- Choose an authorized test recipient and separately authorize sending their setup email. No email is automatically authorized by adding a name to the roster or preparing an account.

The application can check its own configuration and account status. It cannot establish inbox delivery merely by checking those settings. The remaining acceptance test uses a real recipient inbox and must be authorized before any message is sent.

## Send and verify deliberately

Under **Account setup & emails**, choose **Review setup email** and separately confirm sending to that recipient. Have the recipient check inbox and spam, open the one-time link, choose a password, save their recovery key, sign out and sign in again. Separately authorize and test password-reset delivery. Only then proceed to an approved small pilot and the remaining approved recipients.

| Status | Meaning and next step |
| --- | --- |
| Account ready | Account preparation completed. It does not establish that an email has been sent. |
| Email service accepted | The provider accepted the send request. Verify receipt in the recipient's inbox. |
| Delivery unknown | A timeout or interruption obscured the result. Check the inbox before choosing to resend. |
| Preparation interrupted | Check account setup to resume safely; this check does not send email. |

Repeated preparation or status checks must not send a second email. Sending/resending remains an explicit action with a cooldown; there is no automatic background email retry. For an already confirmed account, the setup action uses the password-reset template to reach the same setup page.

Use the broader [launch checklist](LAUNCH-CHECKLIST.md) for the Chair's policy decisions, member privacy checks, syllabus approvals and operational readiness. Email delivery alone does not establish that the portal is ready for the whole chapter.
