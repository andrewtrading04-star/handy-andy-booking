// Master on/off switch for outbound notifications (SMS + email).
//
// Twilio (texting) and the Resend email accounts are still pending approval, so
// notifications are OFF by default — the app skips sends instead of attempting
// them. Turn everything back on once both are approved by setting
// NOTIFICATIONS_ENABLED=1 (or "true") in the environment, then redeploy.
export function notificationsOn() {
  const v = (process.env.NOTIFICATIONS_ENABLED || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}
