/**
 * The numeral validator — the thing standing between the Tier 3 model choice
 * and a database of confident fabrications.
 *
 * Reject any sentence containing a numeral absent from the input facts,
 * INCLUDING a correct one the model derived. "Orbits roughly 16 times a day"
 * from a 92-minute period is arithmetic we cannot verify at scale; "carries 6
 * instruments" from facts listing none is invention. From the output alone the
 * two look identical, so both are rejected and the sentence falls back to Tier 2.
 *
 * Same discipline as checkNarrative() in workers/orbit-ingest/src/brief.js. Not
 * a port: that function guards one daily paragraph against a fixed fact object;
 * this one runs ~3k times against heterogeneous per-object facts. The rule and
 * the reasoning carry over; the shape does not.
 *
 * Pure. No I/O — two plain arguments, which is what makes it cheap to prove.
 */

/**
 * A numeral: an optional sign is deliberately NOT matched (a leading "-" in the
 * data is a COSPAR/date separator far more often than a negative number), a run
 * of digits with optional thousands separators, and an optional decimal part.
 */
const NUMERAL = /\d[\d,]*(?:\.\d+)?/g;

/**
 * One numeral token in canonical form: commas stripped, and — for a decimal —
 * trailing zeros and a bare trailing dot removed, so `92.680` and `92.68` and
 * `6,161` and `6161` compare equal. Integers pass through untouched (a
 * zero-padded `067` stays `067`; the Number() form below also admits `67`).
 */
function normalizeNumeral(token) {
  let t = String(token).replace(/,/g, '');
  if (t.includes('.')) t = t.replace(/\.?0+$/, '');
  return t || '0';
}

/**
 * Every numeral in `text`, normalised. Order-preserving, duplicates kept — the
 * caller wants to know what a sentence actually said.
 * @returns {string[]}
 */
export function extractNumerals(text) {
  return (String(text ?? '').match(NUMERAL) || []).map(normalizeNumeral);
}

/**
 * Every numeral appearing anywhere in `facts` — in numeric values and inside
 * strings alike, because a COSPAR id, an epoch or a name legitimately puts
 * digits in the model's input and quoting them back is correct. Both the
 * normalised literal and Number()'s form are added, so a zero-padded "067" in a
 * designator still admits a bare "67".
 * @returns {Set<string>}
 */
export function factNumerals(facts) {
  const out = new Set();

  const add = (token) => {
    const t = normalizeNumeral(token);
    out.add(t);
    const n = Number(t);
    if (Number.isFinite(n)) out.add(String(n));
  };

  const walk = (node) => {
    if (node == null) return;
    if (typeof node === 'number') { add(String(node)); return; }
    if (typeof node === 'string') {
      for (const m of node.match(NUMERAL) || []) add(m);
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') { Object.values(node).forEach(walk); }
  };

  walk(facts);
  return out;
}

/** Split into sentences on `.`/`!`/`?` boundaries, keeping the terminator. */
function sentences(prose) {
  return String(prose ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} prose
 * @param {Record<string, any>} facts  the verified Tier 1 facts the prose was generated from
 * @returns {{ok: boolean, rejected: string[], reason: string|null}}
 *   `rejected` holds each offending sentence verbatim; `reason` names the first
 *   unsupported numeral. ok === true iff rejected.length === 0.
 */
export function validateProse(prose, facts) {
  const allowed = factNumerals(facts);
  const rejected = [];
  let reason = null;

  for (const sentence of sentences(prose)) {
    for (const token of extractNumerals(sentence)) {
      if (allowed.has(token) || allowed.has(String(Number(token)))) continue;
      rejected.push(sentence);
      if (reason === null) reason = `unsupported numeral "${token}" — not present in the facts`;
      break;
    }
  }

  return { ok: rejected.length === 0, rejected, reason };
}
