export const BRACKET_TYPES = Object.freeze(['flat', 'tilting', 'full_motion']);
const empty = () => ({ flat: 0, tilting: 0, full_motion: 0 });
const OWN = /customer[\s'-]*(?:supplied|provided|owned|own)|(?:my|your|their|customer'?s)\s+own|(?:comes?\s+)?in[ -](?:the[ -])?box|samsung\s*frame|lg\s*gallery/i;
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();

// Only explicit material fields or catalog labels identify company hardware.
// Doubtful descriptions become review items, never guessed stock movements.
export function classifyBracketMaterials(lines = []) {
  const qtys = empty(), issues = [], entries = [], seen = new Map();
  const source_lines = lines.map(li => ({ name: String(li?.name || ''), quantity: Number(li?.quantity ?? 1),
    material_type: li?.material_type || null, material_owner: li?.material_owner || null }));
  for (const [index, li] of lines.entries()) {
    const original = String(li?.name || ''), name = normalize(original), owner = li?.material_owner;
    if (owner === 'customer' || (!owner && OWN.test(name))) continue;
    let type = li?.material_type || null;
    if (type && !BRACKET_TYPES.includes(type)) {
      issues.push({ code: 'unknown_material', index, name: original, message: 'Choose flat, tilting, or full motion.' }); continue;
    }
    if (owner && !['company', 'customer'].includes(owner)) {
      issues.push({ code: 'unknown_owner', index, name: original, message: 'Specify company or customer hardware.' }); continue;
    }
    const suffix = name.match(/\s*(?:[×✕✖]|\bx)\s*(\d+)\s*$/);
    const core = (suffix ? name.slice(0, suffix.index) : name).trim().replace(/^bracket\s*:\s*/, '')
      .replace(/^8[45]\s*"?\s*-\s*100\s*"?\s*(?:tv\s*)?/, '')
      .replace(/\s*-\s*8[45]\s*"?\s*-\s*100\s*"?\s*$/, '')
      .replace(/\s*\(85\s*"?\s+and\s+up\)\s*$/, '')
      .replace(/\s*\(recommended\)\s*/, ' ').replace(/\s+/g, ' ').trim();
    const catalog = /^(flat|fixed|tilt|tilting|full[ -]?motion)(?:\s+(?:tv\s+)?(?:brackets?|mounts?))?$/.exec(core);
    if (!type && catalog) type = /full/.test(catalog[1]) ? 'full_motion' : /tilt/.test(catalog[1]) ? 'tilting' : 'flat';
    if (!type) {
      const suspiciousType = /^(?:flat|fixed|tilt(?:ing)?|full[ -]?motion)\b/.test(name) && !/^(?:flat\s+rate|fixed\s+(?:the|price))\b/.test(name);
      if (suspiciousType || (/\b(?:brackets?|mounts?)\b/.test(name) && !/apple\s*tv|soundbar|mantel|dismount|remount|mounting|installation|install\b/.test(name))) {
        issues.push({ code: 'ambiguous_material', index, name: original, message: 'This hardware label is not a recognized bracket type.' });
      }
      continue;
    }
    const rawQty = Number(li?.quantity ?? 1), suffixQty = suffix ? Number(suffix[1]) : null;
    if (!Number.isInteger(rawQty) || rawQty < 1 || rawQty > 99 || (suffixQty != null && (suffixQty < 1 || suffixQty > 99))) {
      issues.push({ code: 'invalid_quantity', index, name: original, message: 'Bracket quantity must be a whole number from 1 to 99.' }); continue;
    }
    if (suffixQty != null && rawQty !== 1 && rawQty !== suffixQty) {
      issues.push({ code: 'quantity_conflict', index, name: original, message: 'Written quantity disagrees with the quantity field.' }); continue;
    }
    const quantity = suffixQty ?? rawQty, explicit = !!li?.material_type;
    const selection = /^(?:flat|fixed|tilt|tilting|full[ -]?motion)$/.test(core);
    const previous = seen.get(type) || [];
    if (!explicit && previous.some(e => !e.explicit && (e.name === name || e.selection !== selection))) {
      issues.push({ code: 'possible_duplicate_material', index, name: original, message: 'Two lines may describe the same bracket. Confirm the physical quantity.' });
    }
    previous.push({ name, selection, explicit }); seen.set(type, previous);
    qtys[type] += quantity;
    entries.push({ type, owner: 'company', quantity, index });
  }
  return { qtys, issues, entries, source_lines, version: 1 };
}

export function requireBracketQuantities(q, { partial = false, signed = false } = {}) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) throw new Error('Bracket quantities are required.');
  const out = {};
  for (const type of BRACKET_TYPES) {
    if (partial && q[type] === undefined) continue;
    if (q[type] === null || typeof q[type] === 'boolean' || (typeof q[type] === 'string' && !q[type].trim())) throw new Error(`Invalid ${type} quantity.`);
    const n = Number(q[type] ?? 0);
    if (!Number.isInteger(n) || Math.abs(n) > 10000 || (!signed && n < 0)) throw new Error(`Invalid ${type} quantity.`);
    out[type] = n;
  }
  return out;
}
