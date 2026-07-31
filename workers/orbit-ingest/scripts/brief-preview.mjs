#!/usr/bin/env node
/**
 * Preview the daily brief without publishing it (plan 33 wave 6).
 *
 *   node workers/orbit-ingest/scripts/brief-preview.mjs            # facts + prompt only
 *   node workers/orbit-ingest/scripts/brief-preview.mjs --generate # + one model call
 *   node workers/orbit-ingest/scripts/brief-preview.mjs --generate --n 5
 *
 * **This exists because of how the plan says to judge this wave**: "drop it
 * without consequence if the output reads as filler." That is a judgement about
 * prose, so it needs a way to *see* the prose — and seeing it must not require
 * turning the feature on in production, waiting a day for the cron, and then
 * looking at the live site.
 *
 * Nothing is written to R2 unless `--write` is passed. The default is read-only
 * against D1 plus, with `--generate`, one inference call.
 *
 * `--n` runs the generation several times so the gate's rejection rate is
 * visible. A model that trips the grounding gate half the time is one to
 * replace (try ORBIT_AI_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast, or
 * ORBIT_AI_PROVIDER=groq) rather than a reason to loosen the gate.
 */

import { createEnv } from './env-node.mjs';
import {
  BRIEF_MODEL, collectFacts, buildPrompt, checkNarrative, cleanNarrative,
  buildBrief, isQuiet,
} from '../src/brief.js';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const generate = has('--generate');
const write = has('--write');
const runs = Math.max(1, Number.parseInt(valueOf('--n', '1'), 10) || 1);

let env;
try {
  // Force the flag on for a preview: the point is to see what the card WOULD
  // say. Nothing is published unless --write, so this cannot leak to the site.
  env = createEnv({ ...process.env, ORBIT_AI_CARDS: generate ? '1' : '0' });
} catch (err) {
  console.error(String(err && err.message || err));
  console.error('\nThis reads the live catalog, so it needs CLOUDFLARE_ACCOUNT_ID, ' +
                'CLOUDFLARE_API_TOKEN and ORBIT_D1_DATABASE_ID at minimum.');
  process.exit(2);
}

if (write) {
  const card = await buildBrief(env);
  console.log(JSON.stringify(card, null, 2));
  console.log(`\nPublished to R2. status: ${card.narrative_status}`);
  process.exit(card.narrative_status.startsWith('rejected') ? 1 : 0);
}

const facts = await collectFacts(env);
const { system, user } = buildPrompt(facts);

console.log('── FACTS ' + '─'.repeat(62));
console.log(JSON.stringify(facts, null, 2));
console.log('\n── PROMPT ' + '─'.repeat(61));
console.log(system + '\n\n' + user);

if (isQuiet(facts)) {
  console.log('\n⚠ Quiet day — the real run would skip generation entirely ' +
              '(a model asked to narrate nothing produces filler by definition).');
}

if (!generate) {
  console.log('\n(no model call — pass --generate to make one)');
  process.exit(0);
}

if (!env.ORBIT_AI) {
  console.error('\nNo AI client configured. Set CLOUDFLARE_AI_TOKEN (or give ' +
                'CLOUDFLARE_API_TOKEN the "Workers AI: Read" permission), or ' +
                'ORBIT_AI_PROVIDER=groq with GROQ_API_KEY.');
  process.exit(2);
}

const model = env.ORBIT_AI_MODEL || BRIEF_MODEL;
console.log(`\n── GENERATED (${model}, ${runs} run${runs > 1 ? 's' : ''}) ` + '─'.repeat(30));

let accepted = 0;
for (let i = 1; i <= runs; i++) {
  let raw;
  try {
    const out = await env.ORBIT_AI.run(model, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 260,
      temperature: 0.2,
    });
    raw = out.response;
  } catch (err) {
    console.log(`\n[${i}] ERROR ${String(err && err.message || err)}`);
    continue;
  }

  const verdict = checkNarrative(raw, facts);
  if (verdict.ok) accepted++;
  console.log(`\n[${i}] ${verdict.ok ? '✅ ACCEPTED' : '❌ REJECTED — ' + verdict.reason}`);
  console.log('    ' + cleanNarrative(raw).replace(/(.{92})\s/g, '$1\n    '));
}

console.log(`\n${accepted}/${runs} accepted by the grounding gate.`);
if (accepted < runs) {
  console.log('Rejections are the gate working, not a bug. If most runs are rejected, ' +
              'change the model — do not loosen the gate.');
}
