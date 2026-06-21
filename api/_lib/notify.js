// Master + per-channel on/off switches for outbound notifications.
//
// Twilio (texting) and the Resend email accounts were originally pending
// approval, so notifications are OFF by default — the app skips sends instead of
// attempting them. There are three knobs (all read "1"/"true"/"yes" as on):
//
//   NOTIFICATIONS_ENABLED        master switch — turns BOTH email + SMS on
//   EMAIL_NOTIFICATIONS_ENABLED  turns just email on (independent of SMS)
//   SMS_NOTIFICATIONS_ENABLED    turns just SMS on (independent of email)
//
// A channel is ON if its own switch is set OR the master switch is set. This
// lets us, e.g., enable email confirmations while leaving texting off until
// Twilio is ready. Set the relevant var, then redeploy.
function flag(name) {
  const v = (process.env[name] || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// Master switch — true when ANY notifications should go out. Kept for callers
// that don't care which channel (and as the umbrella for both below).
export function notificationsOn() {
  return flag('NOTIFICATIONS_ENABLED');
}

// Email on if its own switch OR the master switch is set.
export function emailNotificationsOn() {
  return flag('EMAIL_NOTIFICATIONS_ENABLED') || notificationsOn();
}

// SMS on if its own switch OR the master switch is set.
export function smsNotificationsOn() {
  return flag('SMS_NOTIFICATIONS_ENABLED') || notificationsOn();
}
