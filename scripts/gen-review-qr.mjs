// Regenerates the QR code SVGs for the tech app's "Leave us a review" card
// (public/tech.html, REVIEW_QR_SVG) and the standalone files under
// public/qr/. Run this whenever a listing in REVIEW_LISTINGS (api/tech.js)
// changes, then paste the printed `const REVIEW_QR_SVG = {...};` block over
// the existing one in public/tech.html.
//
// Needs the `qrcode` package, which is intentionally NOT a project
// dependency (this script runs rarely, by hand): `npm install --no-save qrcode`
// before running, then `npm uninstall qrcode` after.
import QRCode from 'qrcode';
import { writeFileSync } from 'node:fs';

const LISTINGS = [
  { key: 'ha-houston-1', url: 'https://g.page/r/CdizxHwpwcE0EBM/review' },
  { key: 'ha-houston-2', url: 'https://g.page/r/CeA7fWzbLgO8EBM/review' },
  { key: 'ha-austin',    url: 'https://g.page/r/CYE7aX6tVMnkEBM/review' },
  { key: 'ha-denver-1',  url: 'https://g.page/r/Ccj-ZjdeLtzfEBM/review' },
  { key: 'ha-denver-2',  url: 'https://g.page/r/CWcIi45TvszbEBM/review' },
  { key: 'doms',         url: 'https://g.page/r/Cffr7Tp2DSNOEBM/review' },
];

const out = {};
for (const l of LISTINGS) {
  const svg = (await QRCode.toString(l.url, { type: 'svg', margin: 1, width: 240 })).trim();
  writeFileSync(new URL(`../public/qr/${l.key}.svg`, import.meta.url), svg);
  out[l.key] = svg;
}
console.log('const REVIEW_QR_SVG = ' + JSON.stringify(out) + ';');
