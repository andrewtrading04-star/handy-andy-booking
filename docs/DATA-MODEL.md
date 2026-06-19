# Business Management System — Data Model & Architecture

This is the Phase 1 foundation that replaces Zenbooker for **Handy Andy TV
Mounting** and **Doms TV Mounting**. The two businesses share one database but
are fully siloed by `business_id`.

## What's here

| Piece | Path | Notes |
|---|---|---|
| SQL schema + seed | `supabase/migrations/0001_initial_schema.sql` | Paste into Supabase SQL Editor and run once. |
| Admin dashboard | `public/admin.html` | Owner + secretary. Vanilla, no build step. |
| Technician app | `public/tech.html` | Mobile-first, phone + PIN login. |
| Admin API | `api/admin.js` | One function, dispatches on `?action=`. |
| Technician API | `api/tech.js` | One function, dispatches on `?action=`. |
| Shared server libs | `api/_lib/*` | Supabase service client, signed-token auth, timezone math. |
| Zenbooker importer | `scripts/import-zenbooker.mjs` | Backfills history. Run locally. |

> **Why two router functions?** Vercel's free (Hobby) tier caps a deployment at
> 12 serverless functions and `/api` already has 10. `admin.js` and `tech.js`
> each bundle many endpoints behind `?action=` to stay under the cap.

## Tables

```
businesses ──┐
             ├─ staff_users           (owner = business_id NULL; secretaries scoped)
             ├─ service_areas ── service_area_zips
             ├─ services ── service_option_groups ── service_options
             ├─ technicians
             └─ customers ── bookings ──┬─ booking_line_items
                                        └─ booking_status_events
```

Every business-owned table carries `business_id`. Pricing mirrors the booking
widget: a **service** has **option groups** (Size, Bracket, Fireplace, Wall
Surface, Wire Hiding, …), each group has priced **options**, and a booking
freezes its chosen options into **line items** (price-at-time-of-booking). Every
service/option keeps its `zenbooker_*` id so historical jobs import cleanly.

## Security model (important)

The Supabase **anon key ships inside the public widgets**, so it must never read
business data. The migration enables **RLS on every table with no anon policies
= anon is denied**. The admin dashboard and tech app reach the database only
through the serverless functions, which use the **service-role key**
(`SUPABASE_SERVICE_ROLE_KEY`, server-side only).

- **Owner** (`ADMIN_PASSWORD`): sees both businesses, switches between them.
- **Secretary** (`HANDY_ANDY_PASSWORD` / `DOMS_PASSWORD`): full control of one
  business only. Scope is enforced server-side from the signed token.
- **Technician**: phone + 4-digit PIN. PINs are stored **hashed** (bcrypt via
  pgcrypto); verification happens inside Postgres (`verify_technician_pin`) so
  the hash never leaves the database. A tech only ever sees their own jobs (tech
  id comes from the token, never the request).

## Setup checklist

1. **Run the migration** — paste `supabase/migrations/0001_initial_schema.sql`
   into Supabase → SQL Editor → Run. It seeds both businesses, their service
   areas, technicians (Kregg/Juan/Steve/Zach, TK/George) and secretaries
   (Heather, Joey).
2. **Set env vars** (locally in `.env`, and in Vercel → Settings → Env):
   see `.env.example`. You must add `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_PASSWORD`,
   `HANDY_ANDY_PASSWORD`, `DOMS_PASSWORD`, and `SESSION_SECRET`.
3. **Set technician phones + PINs** in the admin dashboard → Technicians tab
   (login required first). Until set, a tech can't log in.
4. **Import Zenbooker history** (optional, when ready):
   ```
   node --env-file=.env scripts/import-zenbooker.mjs --since=2023-01-01 --dry-run
   # verify the printed mapping, then:
   node --env-file=.env scripts/import-zenbooker.mjs --since=2023-01-01
   ```

## URLs (after deploy)

- Admin dashboard: `/admin.html`
- Technician app: `/tech.html`

## Live data (no import required for new bookings)

`api/book.js` (Handy Andy widget) and `api/assurion-book.js` (Asurion channel)
now **mirror each new booking into Supabase** right after Zenbooker creates the
job — see `api/_lib/mirror.js`. It's best-effort: it never blocks or fails a
booking, and it no-ops if `SUPABASE_SERVICE_ROLE_KEY` isn't set. Prices/times
come from the Zenbooker response and reconcile later via the importer.

- **Asurion** is a channel into Handy Andy that books **Steve**. Those bookings
  are `business='handy-andy'`, `source='asurion'`, tech = Steve (linked by his
  Zenbooker provider id in migration `0002`).

## Manual / phone bookings

The dashboard's **＋ New** button creates a booking by hand (reusing an existing
customer by phone/email, or creating one). Source is tagged `manual`.

## Real-time status

The tech app's status buttons (**On My Way → Arrived → Start Job → Job
Complete**) update the booking and the technician's availability. The admin
**Today** view polls every 20s, so status changes surface there within seconds.
(No Supabase Realtime is used, which keeps the anon key away from business data.)

## Not in Phase 1 (designed to plug in later)

Calendar/availability engine, SMS/email confirmations (Twilio/SendGrid),
customer-facing reschedule, payments/charging beyond card-on-file, per-area
option pricing UI, and real staff auth (the `staff_users` table is already
there for it).
