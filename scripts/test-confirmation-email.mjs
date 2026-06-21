// scripts/test-confirmation-email.mjs
// Sends a REAL test email through Resend to confirm a verified domain (DKIM/SPF)
// actually delivers. Use after both domains show "Verified" in Resend.
//
//   node --env-file=.env scripts/test-confirmation-email.mjs handy-andy you@example.com
//   node --env-file=.env scripts/test-confirmation-email.mjs doms       you@example.com
//
// It picks the same API key + from-address the app uses (see api/_lib/email.js).
// This sends directly (it does NOT check NOTIFICATIONS_ENABLED) because the whole
// point is to verify deliverability before flipping the master switch.

const [, , bizArg, toArg] = process.argv;
const slug = (bizArg || '').toLowerCase();
const to = toArg;

if (!['handy-andy', 'doms'].includes(slug) || !to) {
  console.error('Usage: node --env-file=.env scripts/test-confirmation-email.mjs <handy-andy|doms> <recipient@email.com>');
  process.exit(1);
}

const cfg = slug === 'doms'
  ? { name: "Dom's TV Mounting", accent: '#2563EB',
      apiKey: process.env.DOMS_RESEND_API_KEY || process.env.RESEND_API_KEY,
      from:   process.env.DOMS_EMAIL_FROM || 'contact@domstvmounting.com' }
  : { name: 'Handy Andy', accent: '#FF6B35',
      apiKey: process.env.RESEND_API_KEY,
      from:   process.env.HANDY_ANDY_EMAIL_FROM || 'contact@ihandyandy.com' };

if (!cfg.apiKey) {
  console.error(`No Resend API key found for "${slug}". Set ${slug === 'doms' ? 'DOMS_RESEND_API_KEY (or RESEND_API_KEY)' : 'RESEND_API_KEY'} in your .env.`);
  process.exit(1);
}

const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;">
  <div style="background:${cfg.accent};color:#fff;padding:18px 22px;border-radius:12px 12px 0 0;font-size:18px;font-weight:800;">${cfg.name}</div>
  <div style="border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;padding:22px;">
    <p style="font-size:15px;color:#222;">This is a <strong>test email</strong> confirming that <strong>${cfg.name}</strong> can send from <code>${cfg.from}</code>.</p>
    <p style="font-size:14px;color:#555;">If you received this in the inbox (not spam) with no security warning, DKIM/SPF are working and you're ready to turn notifications on.</p>
    <p style="font-size:12px;color:#999;">Sent ${new Date().toISOString()}</p>
  </div>
</div>`;

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    from: cfg.from,
    to,
    subject: `${cfg.name} — email deliverability test`,
    html,
  }),
});

const body = await res.text();
if (res.ok) {
  console.log(`✅ Sent from ${cfg.from} → ${to}`);
  console.log('   Resend response:', body);
  console.log('   Check the inbox (and spam) for the test message.');
} else {
  console.error(`❌ Resend error ${res.status}`);
  console.error('  ', body);
  process.exit(1);
}
