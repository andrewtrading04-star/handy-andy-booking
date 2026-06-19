#!/usr/bin/env node
// Fetches Doms pricing from Zenbooker and saves to doms-pricing.json
const KEY = 'zbk_9Q5ZIc0uIvC0HVCEQPFHcfoj-PpeQibqQK3k90yVY7s8k9UpX5xd3fn9G';

async function get(path) {
  const r = await fetch('https://api.zenbooker.com' + path, {
    headers: { 'Authorization': `Bearer ${KEY}` }
  });
  return r.json();
}

const [services, serviceTypes, territories] = await Promise.all([
  get('/v1/services'),
  get('/v1/service_types'),
  get('/v1/territories'),
]);

const out = { services, serviceTypes, territories };
import { writeFileSync } from 'node:fs';
writeFileSync('./doms-pricing.json', JSON.stringify(out, null, 2));
console.log('Done! Paste the contents of doms-pricing.json back to Claude.');
console.log(JSON.stringify(out, null, 2));
