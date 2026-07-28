# Grasshopper voicemail tracking: setup

Grasshopper has no API, no webhooks and no Zapier integration (checked Jul 2026).
The only thing it emits that a computer can read is the notification email it
sends to the owner's inbox, so that email is the integration.

A small script on Andrew's own Google account watches for those emails and sends
them to the dashboard. Nothing else in the inbox is read, and it can be switched
off from the same screen it was switched on.

---

## Step 1: add the secret to Vercel (one time)

This is the password the script uses to prove it's really us.

1. Go to the `handy-andy-booking` project on Vercel
2. Settings, then Environment Variables
3. Add a new one:
   - Name: `GRASSHOPPER_INGEST_SECRET`
   - Value: `ooEt6DZPHUUGg5iTyGyQY0YVgVOeA87t`
4. Save, then redeploy

Until this is set the endpoint stays closed and returns "Call ingest is not
configured". That is deliberate: a missing secret must never mean "let anyone
write call records".

---

## Step 2: create the script (one time)

1. Go to <https://script.google.com> signed in as andrewtrading04@gmail.com
2. Click **New project**
3. Delete whatever is in the editor and paste the whole script below
4. Click the **save** icon, and name the project `Grasshopper Voicemails`
5. In the left sidebar click the gear (**Project Settings**), scroll to
   **Script Properties**, click **Add script property**:
   - Property: `INGEST_SECRET`
   - Value: `ooEt6DZPHUUGg5iTyGyQY0YVgVOeA87t`
   - Save

The secret lives here rather than in the code so the script can be shared or
edited without the password being in it.

---

## Step 3: turn it on

1. At the top of the editor pick the function **`syncNow`** and click **Run**
2. Google will ask for permission to read Gmail. Approve it. (It shows a
   "Google hasn't verified this app" warning because it's your own private
   script. Click Advanced, then "Go to Grasshopper Voicemails".)
3. In the left sidebar click the clock (**Triggers**), then **Add Trigger**:
   - Function: `syncNow`
   - Event source: Time-driven
   - Type: Minutes timer
   - Interval: Every 5 minutes
   - Save

That's it. New voicemails appear in the Calls tab within about five minutes.

---

## Step 4 (optional): pull in the old ones

Run the **`backfillAll`** function once to import the voicemail history. It
processes the whole archive in batches, and deliberately does NOT text anyone,
since alerting the office about months-old voicemails would just be noise.

If it times out (Google caps a run at about six minutes), just run it again. It
picks up where it left off.

---

## The script

```javascript
// Forwards Grasshopper voicemail notification emails to the booking dashboard.
// Reads ONLY emails from notifications@grasshopper.com. Nothing else is touched.

var ENDPOINT = 'https://handy-andy-booking.vercel.app/api/admin?action=call_ingest';
var SEARCH   = 'from:notifications@grasshopper.com subject:"Voicemail from"';
var LABEL    = 'Grasshopper/Synced';

// Normal run: newest first, small batch, alerts the office. Called by the timer.
function syncNow()    { processMessages(25,  false); }
// History import: bigger batches, no alerts.
function backfillAll() { processMessages(300, true); }

function processMessages(max, isBackfill) {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
  if (!secret) throw new Error('Set the INGEST_SECRET script property first (see setup step 2).');

  var label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  // The label is what stops the same email being sent twice. The server ALSO
  // refuses duplicates by Gmail message id, so even if the label is removed by
  // hand nothing is double-counted.
  var threads = GmailApp.search(SEARCH + ' -label:"' + LABEL + '"', 0, max);
  if (!threads.length) { Logger.log('Nothing new.'); return; }

  var sent = 0, failed = 0;
  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    var allOk = true;

    for (var j = 0; j < messages.length; j++) {
      var m = messages[j];
      if (m.getFrom().indexOf('grasshopper.com') === -1) continue;   // safety net

      var payload = {
        secret:        secret,
        subject:       m.getSubject(),
        body:          m.getPlainBody(),
        receivedAt:    m.getDate().toISOString(),   // the real instant, no timezone guessing
        messageId:     m.getId(),                   // the de-duplication key
        hasAttachment: m.getAttachments().length > 0,
        backfill:      !!isBackfill
      };

      try {
        var res = UrlFetchApp.fetch(ENDPOINT, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        var code = res.getResponseCode();
        if (code >= 200 && code < 300) {
          sent++;
        } else {
          // 422 means the email could not be read (an unexpected layout). Log it
          // and move on rather than getting stuck retrying the same message.
          allOk = (code === 422);
          failed++;
          Logger.log('HTTP ' + code + ' for "' + m.getSubject() + '": ' + res.getContentText());
        }
      } catch (err) {
        allOk = false; failed++;
        Logger.log('Failed on "' + m.getSubject() + '": ' + err);
      }
    }

    // Only label the thread once every message in it was accepted, so a network
    // blip leaves the thread to be retried on the next run instead of silently
    // dropping a customer's voicemail.
    if (allOk) threads[i].addLabel(label);
  }
  Logger.log('Sent ' + sent + ', failed ' + failed + '.');
}
```

---

## How to check it is working

- **In the dashboard:** the Calls tab shows the voicemails, with a red count on
  the sidebar for any that still need a callback.
- **In Gmail:** synced messages get a `Grasshopper/Synced` label.
- **In Apps Script:** Executions in the left sidebar shows every run and its log.

## If something goes wrong

- **"Call ingest is not configured"** — step 1 was skipped, or the project has
  not been redeployed since adding the variable.
- **401 Unauthorized** — the script property and the Vercel variable do not
  match. They must be character for character identical.
- **422** — an email arrived in a layout the parser does not recognize. The log
  line names the subject. Nothing is lost; forward that email to Claude and the
  parser can be taught the new shape.
- **Nothing arriving** — check Triggers still lists `syncNow`. Google disables
  triggers on an account that has gone untouched for months.

## Turning it off

Delete the trigger (the clock icon in Apps Script). The dashboard keeps every
call already recorded; it simply stops receiving new ones.
