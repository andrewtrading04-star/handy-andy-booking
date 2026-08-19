# Twilio tracking numbers

Real local phone numbers we own on Twilio. A call to one of them forwards to a
person's cell **and** posts a webhook, so a row lands in the Calls tab the
moment the phone rings — answered or not.

This is the thing Grasshopper cannot do. Grasshopper has no API, no webhooks and
no Zapier (verified Jul 2026), so the only signal it emits is a voicemail email
(see `docs/grasshopper-gmail-script.md` and `api/_lib/grasshopper.js`). That
means no missed-call records, no durations, and nothing at all for a call
somebody answered. Twilio numbers close that gap, and because each number is its
own line, putting a distinct one on an ad or a location page turns the Calls tab
into campaign attribution for free.

Cost: ~$1.15/month per number, plus ~$0.014/min inbound and ~$0.014/min for the
forwarded leg while a call is connected. A few hundred minutes a month is
roughly $5–12 total. CallRail and friends charge $45+/month for the same data in
somebody else's dashboard.

## How a call flows

1. Customer dials the tracking number.
2. Twilio POSTs `/api/analytics?action=voice_inbound`. We look the number up in
   `app.tracking_numbers`, insert an `app.calls` row (`source='twilio'`,
   `kind='inbound'`), and answer with TwiML that dials `forward_to`.
   - `callerId` is the **caller's own number**, so whoever picks up sees who is
     really calling and can hit redial. The handset therefore cannot show which
     line was dialed, which is what the whisper is for.
   - **Whisper**: the `url` on `<Number>` is fetched the moment the person picks
     up and plays the line's `label` to THEM only — the caller hears ringing
     throughout. With a dozen numbers across several cities this is the only way
     to know what you answered before you say hello, so keep labels short and
     speakable ("Austin", "Denver Google Ads"): it is dead air on a live call.
   - An unmapped number still connects; the row gets a warning badge instead.
3. When the `<Dial>` ends, Twilio POSTs `voice_status`. Answered calls get
   `answered=true`, a duration, and are closed out (`handled_by='Answered'`) so
   they never sit in the callback queue. Anything else drops the still-connected
   caller into voicemail.
4. Voicemail recording + transcription POST `voice_recording`, which attaches
   both and texts `forward_to` once that a message is waiting.

All three verify Twilio's `X-Twilio-Signature` against the exact callback URL,
built by `voiceUrl()` so the signed string and the verified string cannot drift.
All three always answer 200 with TwiML: a non-2xx makes Twilio read its own
"application error" message to a live customer.

## Adding a number

1. Buy the number in the Twilio console (Phone Numbers → Buy a number), voice
   capability, whatever area code the campaign needs.
2. On the number's config, set **A call comes in** to
   `https://<PUBLIC_URL>/api/analytics?action=voice_inbound`, HTTP POST.
   Leave the status-callback fields alone — the TwiML carries its own.
3. Insert the row. Nothing here is code, so a new number never needs a deploy:

```sql
insert into app.tracking_numbers (phone, label, business_slug, market, forward_to)
values ('5125550147', 'Austin Google Ads', 'handy-andy', 'Austin', '+13374997817');
```

`phone` is bare 10 digits (that is how the webhook normalizes `To`).
`forward_to` is E.164, or `null` to send every call straight to voicemail.
Set `record_calls=true` only where recording both sides is wanted — two-party
consent states make that a real decision, not a default.

To retire a number without losing its history, set `active=false`; calls to it
then go to voicemail instead of ringing anyone.

## Env vars

Already set for SMS, reused here: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`PUBLIC_URL`. `TWILIO_AUTH_TOKEN` is what signature verification depends on — if
it is missing, every voice webhook is rejected and calls fall through to
voicemail.
