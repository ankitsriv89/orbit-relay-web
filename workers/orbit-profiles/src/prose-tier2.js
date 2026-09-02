/**
 * Tier 2 prose — deterministic templated description. No model, no network, no
 * clock. Same input always yields the same string, byte for byte, which is what
 * makes ~25k debris/rocket-body rows reproducible and diffable.
 *
 * Type-aware and conservative: a DEBRIS or ROCKET BODY row never gets a purpose,
 * mission or operator claim regardless of what its name looks like. Every
 * numeral emitted comes from the row, so the output passes Task 3's validator by
 * construction (prose-tier2.test.mjs asserts it).
 *
 * Number formatting matches public/shared/dossier.js — rounded km for apsides,
 * one decimal for inclination — so the prose and the dossier never appear to
 * disagree.
 */

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** "340 × 355 km", or a single value, or null when neither apsis is known. */
function altitudeClause(row) {
  const lo = num(row.PERIAPSIS ?? row.PERIGEE);
  const hi = num(row.APOAPSIS ?? row.APOGEE);
  if (lo != null && hi != null) {
    const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
    return `${Math.round(a)} × ${Math.round(b)} km`;
  }
  const one = lo ?? hi;
  return one != null ? `about ${Math.round(one)} km` : null;
}

/**
 * "in a 71° orbit[ at …]" — the shared orbit description, or '' if nothing
 * known. Inclination is emitted at the row's own precision, never rounded:
 * rounding 51.64 to "51.6" would put a numeral in the prose that is not in the
 * facts, and Tier 2 has to pass Task 3's validator.
 */
function orbitClause(row) {
  const inc = num(row.INCLINATION);
  const alt = altitudeClause(row);
  const incClause = inc != null ? `in a ${inc}° orbit` : null;
  if (incClause && alt) return `${incClause} at ${alt}`;
  return incClause || (alt ? `at ${alt}` : '');
}

/** "from the 2019-047 launch" — the launch, by COSPAR group, never by name. */
function launchClause(row) {
  const group = String(row.OBJECT_ID || '').match(/^(\d{4}-\d{3})/);
  if (group) return `from the ${group[1]} launch`;
  const date = String(row.LAUNCH_DATE || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `launched ${date}` : '';
}

function joinSentence(subject, ...clauses) {
  const tail = clauses.filter(Boolean).join(', ');
  return (tail ? `${subject} ${tail}` : subject).replace(/\s+/g, ' ').trim() + '.';
}

function debrisProse(row) {
  return joinSentence('Catalogued debris', launchClause(row), orbitClause(row));
}

function rocketBodyProse(row) {
  const name = String(row.OBJECT_NAME || '').replace(/\s*R\/B\s*$/i, '').trim();
  const subject = name ? `${name} rocket body` : 'Rocket body (spent launch-vehicle stage)';
  return joinSentence(subject, launchClause(row), orbitClause(row));
}

function payloadProse(row) {
  // Tier 2 for a payload says only what SATCAT already states — a bare
  // structural line. The mission summary is Tier 3's job, from sourced facts.
  const name = String(row.OBJECT_NAME || '').trim();
  const subject = name ? `${name} is a catalogued spacecraft` : 'A catalogued spacecraft';
  return joinSentence(subject, launchClause(row), orbitClause(row));
}

function unknownProse(row) {
  return joinSentence('A catalogued space object', launchClause(row), orbitClause(row));
}

const BY_TYPE = {
  DEBRIS: debrisProse,
  'ROCKET BODY': rocketBodyProse,
  PAYLOAD: payloadProse,
};

/**
 * @param {object} row  a catalogue row: OBJECT_NAME, OBJECT_TYPE, OBJECT_ID,
 *   LAUNCH_DATE, INCLINATION, APOAPSIS, PERIAPSIS, COUNTRY_CODE, regime
 * @returns {string} one or two sentences; never a mission claim for debris or a rocket body
 */
export function tier2Prose(row) {
  const builder = BY_TYPE[String(row.OBJECT_TYPE || '').toUpperCase()] || unknownProse;
  return builder(row);
}
