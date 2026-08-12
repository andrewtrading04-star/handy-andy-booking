// Crop N rows off the top of an 8-bit PNG, in pure Node (this repo has no
// image dependency and this runs rarely, by hand).
//
//   node scripts/crop-png-top.mjs in.png              -> per-row ink report,
//                                                        pick the cut line from it
//   node scripts/crop-png-top.mjs in.png out.png 110  -> write the cropped copy
//
// Used to strip the "Reply to review" admin header off the Google review
// screenshot shown on the widget dismount step (public/reviews/).
// Minimal pure-Node PNG crop (no image deps available). Decodes an 8-bit
// RGBA non-interlaced PNG, removes the top N rows, re-encodes.
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let off = 8, ihdr = null; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = {
      width: data.readUInt32BE(0), height: data.readUInt32BE(4),
      bitDepth: data[8], colorType: data[9], interlace: data[12],
    };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (ihdr.bitDepth !== 8) throw new Error('only 8-bit supported, got ' + ihdr.bitDepth);
  if (ihdr.interlace !== 0) throw new Error('interlaced not supported');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!ch) throw new Error('unsupported colorType ' + ihdr.colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width: w, height: h } = ihdr;
  const stride = w * ch;
  const px = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  };
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const A = i >= ch ? cur[i - ch] : 0;
      const B = prev ? prev[i] : 0;
      const C = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += A; else if (filter === 2) v += B;
      else if (filter === 3) v += (A + B) >> 1; else if (filter === 4) v += paeth(A, B, C);
      cur[i] = v & 0xff;
    }
  }
  return { w, h, ch, px, stride };
}

function encode({ w, h, ch, px, stride }) {
  // Filter type 0 (None) on every row: valid PNG, slightly larger, no risk.
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = { 1: 0, 3: 2, 2: 4, 4: 6 }[ch]; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

let TBL = null;
function crc32(buf) {
  if (!TBL) {
    TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TBL[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const img = decode(readFileSync(process.argv[2]));
const cut = Number(process.argv[4]);

if (!cut) {
  // Report mode: how much non-white content sits on each of the top rows, so
  // the cut line is chosen from the actual pixels instead of eyeballed.
  console.log(`${img.w} x ${img.h}, ${img.ch} channels`);
  const ink = [];
  for (let y = 0; y < Math.min(260, img.h); y++) {
    let n = 0;
    for (let x = 0; x < img.w; x++) {
      const i = y * img.stride + x * img.ch;
      if (img.px[i] < 230 || img.px[i + 1] < 230 || img.px[i + 2] < 230) n++;
    }
    ink.push(n);
  }
  let run = 0;
  ink.forEach((n, y) => {
    if (n === 0) { run++; return; }
    if (run > 3) console.log(`  rows ${y - run}-${y - 1}: BLANK (${run} rows)`);
    run = 0;
    if (y % 1 === 0 && n > 0) console.log(`  row ${String(y).padStart(3)}: ${n} ink px ${'#'.repeat(Math.min(60, Math.ceil(n / 8)))}`);
  });
  process.exit(0);
}

const h2 = img.h - cut;
const out = { w: img.w, h: h2, ch: img.ch, stride: img.stride,
  px: img.px.subarray(cut * img.stride, img.h * img.stride) };
writeFileSync(process.argv[3], encode(out));
console.log(`cropped ${cut}px off the top -> ${img.w} x ${h2}`);
