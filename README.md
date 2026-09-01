# Ilawo Financial Portal

Mobile-first school finance and custody portal for Ilawo Community Grammar School, Ilawo.

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add the Supabase project URL and public anon/publishable key.
3. Add the service-role key and a long `BOOTSTRAP_SECRET` only to server-side environments. Never prefix the service key with `NEXT_PUBLIC_`.
4. Apply `supabase/migrations/202609010001_financial_portal.sql` to the intended Supabase project.
5. Run `npm install`, then `npm run dev`.

The app has no public sign-up screen. The first principal is created once at `/setup` with the server-only bootstrap secret. After the first principal exists, the endpoint refuses further bootstrap requests. Principal-created staff accounts use the server-only admin route.

## Data rules

- Student payments are insert-only. There are no client update/delete policies.
- Corrections and reversals create a separate request and, after approval, an immutable adjustment/replacement record.
- Handover creation and confirmation use database functions so payment custody cannot be silently changed by the browser.
- Audit records are append-only and are written by database triggers for financial events.
- Personal Business tables are separate from school financial tables and have separate RLS permissions.

## Import

The Students screen accepts CSV and Excel files using the headers in `public/student-import-template.csv` (or the download button in the app). Import is preview-first and requires the `manage_students` permission.

## Initial configuration

The migration seeds only classes, initial categories and a configurable `2026/2027` session/terms. It intentionally does not seed student names or expected charge amounts. Add expected charges and import the school's real student list after confirming the session configuration.
