# Database Migration Status

## Issue: Missing sms_consent Column

The `sms_consent` column was not found in the booking table schema cache, causing warnings when creating appointments.

### Root Cause
Migration `0014_sms_consent.sql` exists but may not have been applied to the Supabase database yet. The Supabase schema cache was out of sync with the codebase.

### Solution Implemented
The code is now defensive and handles the missing column gracefully:

1. **Booking Creation** (`api/admin.js` - `bookingCreate`):
   - Attempts to insert with `sms_consent` first
   - If the column doesn't exist in schema cache, automatically retries without it
   - Bookings can be created successfully either way

2. **Booking Updates** (`api/admin.js` - `bookingUpdate`):
   - Now selects `sms_consent` when available
   - SMS notifications only sent if column exists and value is true

3. **Migration Helper Endpoint** (`api/migrate.js`):
   - `GET /api/migrate?action=status` - Check if sms_consent column exists
   - Requires admin authentication

### What Migration 0014 Does
- Adds `sms_consent` boolean column to `app.bookings` table
- Defaults to `true` (customers opted in)
- Creates index for querying by SMS consent

### How to Apply the Migration

#### Option 1: Supabase Dashboard (Recommended)
1. Go to your Supabase project SQL Editor
2. Open `supabase/migrations/0014_sms_consent.sql`
3. Copy and paste the SQL into the editor
4. Run it

#### Option 2: Supabase CLI
```bash
supabase db push
```

#### Option 3: Wait for Auto-Migration
The code will work without the migration applied. SMS notifications won't be sent/tracked until the migration is applied, but all other functionality continues normally.

### Status
- ✅ Code is defensive and handles missing column
- ✅ Booking creation works with or without migration
- ✅ SMS functionality gracefully degrades if column is missing
- 📋 Migration still needs to be applied for full SMS consent tracking

### Related Migrations
- `0014_sms_consent.sql` - Adds sms_consent to bookings table
- `0016_handyman_estimates.sql` - Already includes sms_consent for estimates table
