#!/usr/bin/env node
/**
 * Task 6, Step 6 — validate the Tier 3 model on a sample before committing to it.
 *
 *   GROQ_API_KEY=... node workers/orbit-profiles/scripts/sample-tier3.mjs
 *   GROQ_API_KEY=... ORBIT_AI_MODEL=llama-3.3-70b-versatile node .../sample-tier3.mjs
 *
 * The spec asks: run one chunk against the real Groq endpoint and read the
 * output. Record how many were rejected by the numeral validator, and whether
 * the surviving prose reads as substantive or as filler. If it reads as filler,
 * the MODEL is the variable to change — not the validator.
 *
 * There is no bulk NSSDCA/GCAT source wired yet, so the fact sets below are
 * hand-built to span the real shape: a comms sat, an EO sat, a science mission,
 * a nav sat, a crewed module, a thin-facts payload, and a rocket body that must
 * NOT get a mission. Every number in each fact set is "sourced" by construction,
 * so a rejection means the model introduced a numeral of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GroqAI, PROFILE_TIER3_MODEL } from '../../orbit-ingest/scripts/ai-node.mjs';
import { tier3Prose, isSubstantive } from '../src/prose-tier3.js';
import { tier2Prose } from '../src/prose-tier2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Load .env (gitignored, CRLF on this box) without overwriting the real env.
 * Checks the worktree root first, then the git common dir's parent — a
 * .claude/worktrees/* session shares the main checkout's .env.
 */
function loadDotEnv() {
  const candidates = [path.join(ROOT, '.env')];
  if (/[/\\]\.claude[/\\]worktrees[/\\]/.test(ROOT)) {
    candidates.push(path.resolve(ROOT, '../../../.env'));   // the main checkout
  }
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const mm = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!mm) continue;
      if (!(mm[1] in process.env)) process.env[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}
loadDotEnv();

const KEY = process.env.GROQ_API_KEY;
if (!KEY) {
  console.error('GROQ_API_KEY is not set. Export it (or prefix the command) and re-run.');
  process.exit(2);
}
const MODEL = process.env.ORBIT_AI_MODEL || PROFILE_TIER3_MODEL;

const ai = new GroqAI({ apiKey: KEY });

/** Each entry: the profiles-row facts, plus a catalogue row for the Tier 2 fallback. */
const SAMPLE = [
  {
    facts: { official_name: 'Envisat', operator_name: 'European Space Agency',
      owner_country: 'Europe', manufacturer: 'Astrium', bus: 'PPF',
      launch_mass_kg: 8211, power_w: 6600, design_life_years: 5, launch_year: 2002,
      mission_type: 'Earth observation', status: 'retired' },
    row: { OBJECT_NAME: 'ENVISAT', OBJECT_TYPE: 'PAYLOAD', OBJECT_ID: '2002-009A',
      LAUNCH_DATE: '2002-03-01', INCLINATION: 98.4, APOAPSIS: 774, PERIAPSIS: 772 },
  },
  {
    facts: { official_name: 'Intelsat 901', operator_name: 'Intelsat',
      owner_country: 'United States', manufacturer: 'Space Systems/Loral',
      bus: 'LS-1300', launch_mass_kg: 4725, design_life_years: 13, launch_year: 2001,
      mission_type: 'Communications', status: 'operational' },
    row: { OBJECT_NAME: 'INTELSAT 901', OBJECT_TYPE: 'PAYLOAD', OBJECT_ID: '2001-024A',
      LAUNCH_DATE: '2001-06-09', INCLINATION: 0.1, APOAPSIS: 35800, PERIAPSIS: 35780 },
  },
  {
    facts: { official_name: 'Kepler', operator_name: 'NASA',
      owner_country: 'United States', manufacturer: 'Ball Aerospace',
      launch_mass_kg: 1052, power_w: 1100, launch_year: 2009,
      mission_type: 'Space science', status: 'retired',
      mission_summary: 'Surveyed a single patch of sky for transiting exoplanets.' },
    row: { OBJECT_NAME: 'KEPLER', OBJECT_TYPE: 'PAYLOAD', OBJECT_ID: '2009-011A',
      LAUNCH_DATE: '2009-03-07', INCLINATION: 0.5, APOAPSIS: 150000, PERIAPSIS: 148000 },
  },
  {
    facts: { official_name: 'GPS IIR-2 (GPS SVN-43)', operator_name: 'US Space Force',
      owner_country: 'United States', manufacturer: 'Lockheed Martin',
      bus: 'AS-4000', launch_mass_kg: 2032, design_life_years: 10, launch_year: 1997,
      mission_type: 'Navigation', status: 'operational' },
    row: { OBJECT_NAME: 'GPS BIIR-2', OBJECT_TYPE: 'PAYLOAD', OBJECT_ID: '1997-035A',
      LAUNCH_DATE: '1997-07-23', INCLINATION: 55.0, APOAPSIS: 20300, PERIAPSIS: 20100 },
  },
  {
    facts: { official_name: 'Zarya (FGB)', operator_name: 'Roscosmos / NASA',
      owner_country: 'International', manufacturer: 'Khrunichev', bus: 'FGB',
      launch_mass_kg: 19323, power_w: 3000, launch_year: 1998,
      mission_type: 'Space station module', status: 'operational',
      mission_summary: 'First module of the International Space Station; provided early propulsion, power and storage.' },
    row: { OBJECT_NAME: 'ISS (ZARYA)', OBJECT_TYPE: 'PAYLOAD', OBJECT_ID: '1998-067A',
      LAUNCH_DATE: '1998-11-20', INCLINATION: 51.6, APOAPSIS: 421, PERIAPSIS: 413 },
  },
  {
    facts: { official_name: 'Starlink-1130 (DARKSAT)', operator_name: 'SpaceX',
      owner_country: 'United States', bus: 'Starlink v1.0', launch_year: 2020,
      mission_type: 'Communications', status: 'decayed' },
    row: { OBJECT_NAME: 'STARLINK-1130', OBJECT_TYPE: 'PAYLOAD', OBJECT_ID: '2020-001AB',
      LAUNCH_DATE: '2020-01-07', INCLINATION: 53.0, APOAPSIS: 550, PERIAPSIS: 540 },
  },
  {
    facts: { official_name: 'Thin-facts payload', owner_country: 'India',
      launch_year: 2015, mission_type: 'Technology demonstration', status: 'operational' },
    row: { OBJECT_NAME: 'TESTSAT', OBJECT_TYPE: 'PAYLOAD', OBJECT_ID: '2015-052C',
      LAUNCH_DATE: '2015-09-28', INCLINATION: 6.0, APOAPSIS: 655, PERIAPSIS: 640 },
  },
  {
    // Must NOT get a mission — isSubstantive() should keep it Tier 2.
    facts: { official_name: 'PSLV fourth stage', owner_country: 'India',
      launch_year: 2015, status: 'decayed' },
    row: { OBJECT_NAME: 'PSLV R/B', OBJECT_TYPE: 'ROCKET BODY', OBJECT_ID: '2015-052D',
      LAUNCH_DATE: '2015-09-28', INCLINATION: 6.0, APOAPSIS: 660, PERIAPSIS: 470 },
  },
];

// Repeat the spread to ~48 calls so a rate-limit / retry path is actually exercised.
const RUNS = 6;

function looksLikeFiller(prose, facts) {
  const hay = prose.toLowerCase();
  const vagueOpeners = /\b(is a satellite|is a spacecraft|was a satellite|plays a (?:key|vital|crucial) role|serves as an? important)\b/;
  const restatesNothing = hay.length < 90;
  const noProperNoun = facts.official_name && !hay.includes(facts.official_name.toLowerCase().split(/[\s(]/)[0]);
  return vagueOpeners.test(hay) || restatesNothing || noProperNoun;
}

let calls = 0;
let rejected = 0;
let tier3 = 0;
let tier2Downgrade = 0;
let fillerFlags = 0;
const transcript = [];

for (let run = 0; run < RUNS; run++) {
  for (const { facts, row } of SAMPLE) {
    const fallback = tier2Prose(row);
    const substantive = isSubstantive(facts);
    calls++;

    if (!substantive) {
      transcript.push({ name: facts.official_name, tier: 2, note: 'not substantive — Tier 2 by design', prose: fallback });
      continue;
    }

    const { prose, tier, rejected: rej } = await tier3Prose(ai, MODEL, facts, fallback);
    if (tier === 3) {
      tier3++;
      const filler = looksLikeFiller(prose, facts);
      if (filler) fillerFlags++;
      transcript.push({ name: facts.official_name, tier: 3, filler, prose });
    } else {
      tier2Downgrade++;
      if (rej && rej.length) rejected += rej.length;
      transcript.push({ name: facts.official_name, tier: 2, note: `downgraded${rej && rej.length ? ` — rejected: ${rej.join(' | ')}` : ''}`, prose });
    }
    await new Promise((r) => setTimeout(r, 400)); // be polite to the endpoint
  }
}

console.log(`\n=== Tier 3 sample — model: ${MODEL} ===`);
console.log(`calls (substantive):      ${calls - RUNS /* the rocket body per run */}`);
console.log(`published Tier 3:         ${tier3}`);
console.log(`downgraded to Tier 2:     ${tier2Downgrade}`);
console.log(`  of those, validator rejections (sentences): ${rejected}`);
console.log(`Tier 3 flagged as filler: ${fillerFlags} / ${tier3}`);
console.log('\n--- a representative slice ---');
for (const t of transcript.slice(0, 10)) {
  console.log(`\n[${t.name}] tier ${t.tier}${t.filler ? ' ⚠ FILLER' : ''}${t.note ? ` (${t.note})` : ''}`);
  console.log(`  ${t.prose}`);
}
console.log('\n--- verdict guidance ---');
console.log('If "flagged as filler" is more than ~2/10 of the Tier 3 output, or the');
console.log('slice above reads as generic, the MODEL is the variable to change — try');
console.log('ORBIT_AI_MODEL=llama-3.3-70b-versatile and re-run. The validator stays as is.');
