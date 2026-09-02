/**
 * Tier 3 prose — constrained rewriting, gated by the numeral validator.
 *
 * The model is given verified Tier 1 facts and asked to PHRASE them. It never
 * sources a number: ~400 input tokens, ~150 output, because the facts are the
 * prompt. Every string returned has passed validateProse(); on rejection the
 * Tier 2 fallback is returned with tier: 2 and the offending sentences. It is
 * never repaired by retrying until it passes, and it never throws — a 429, a
 * timeout, a malformed response and a null client all resolve to the fallback,
 * and the object stays Tier 2 and requeues.
 *
 * Reuses the ai-node.mjs seam: `ai.run(model, input) → {response}`, the same
 * interface WorkersAI and GroqAI both normalise to.
 */
import { validateProse } from './validate.js';

const SYSTEM = [
  'You write a two to four sentence factual description of a spacecraft for an encyclopedia.',
  'Rules, all mandatory:',
  '- Use ONLY the facts given. Never compute, estimate, round or invent a number.',
  '- Do not add history, context or commentary that is not in the facts.',
  '- If a fact is absent, leave it out — do not guess it.',
  '- Plain prose. No headings, no lists, no markdown, no links. Past tense where the object is retired.',
  '- No greeting, no sign-off.',
].join('\n');

const FIELD_LABELS = {
  official_name: 'Name',
  operator_name: 'Operator',
  owner_country: 'Owner / country',
  manufacturer: 'Manufacturer',
  bus: 'Satellite bus',
  launch_mass_kg: 'Launch mass (kg)',
  power_w: 'Power (W)',
  design_life_years: 'Design life (years)',
  launch_year: 'Launch year',
  mission_type: 'Mission type',
  mission_summary: 'Mission',
  status: 'Status',
};

/** The facts as flat labelled lines — a small model follows a list better than JSON. */
export function buildTier3Prompt(facts) {
  const lines = [];
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const v = facts[key];
    if (v != null && v !== '') lines.push(`${label}: ${v}`);
  }
  return {
    system: SYSTEM,
    user: `Facts:\n${lines.join('\n')}\n\nWrite the description.`,
  };
}

/** Strip the wrappers small instruct models add; what remains still must pass the gate. */
function clean(raw) {
  let t = String(raw == null ? '' : raw).trim();
  t = t.replace(/^```[a-z]*\s*|\s*```$/g, '');
  t = t.replace(/^(?:here(?:'s| is)[^:\n]*:\s*)/i, '');
  t = t.replace(/^#+\s*/gm, '').replace(/^[-*•]\s+/gm, '');
  t = t.replace(/\*\*|__|\*|_/g, '');
  t = t.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (t.length > 1 && /^["'“”]/.test(t) && /["'”]$/.test(t)) t = t.slice(1, -1).trim();
  // A response truncated at the token ceiling ends mid-sentence — drop that
  // trailing fragment rather than publishing "...built on the Starlink v1.".
  // (Step-6 sample: gpt-oss-20b did this often enough to matter.)
  if (!/[.!?]["'”]?$/.test(t)) {
    const lastStop = Math.max(t.lastIndexOf('.'), t.lastIndexOf('!'), t.lastIndexOf('?'));
    t = lastStop > 0 ? t.slice(0, lastStop + 1) : t;
  }
  return t;
}

const MIN_CHARS = 40;

/**
 * Whether an object's Tier 1 facts are substantive enough to hand to the model.
 * An explicit, deliberately NARROW predicate — the reason to gate is
 * hallucination surface and review burden, not cost. Tier 3 runs only when the
 * profile carries a real mission handle (a summary, or a type plus at least one
 * of operator / manufacturer / bus). A bare name-and-country row stays Tier 2.
 *
 * @param {Record<string, any>} facts  a `profiles` row
 * @returns {boolean}
 */
export function isSubstantive(facts) {
  if (!facts) return false;
  if (nonEmpty(facts.mission_summary)) return true;
  const hasType = nonEmpty(facts.mission_type);
  const hasMaker = nonEmpty(facts.operator_name) || nonEmpty(facts.manufacturer) || nonEmpty(facts.bus);
  return hasType && hasMaker;
}

const nonEmpty = (v) => v != null && String(v).trim() !== '';

/**
 * @param {object|null} ai      the ai-node.mjs client: `run(model, input) => {response}`
 * @param {string} model
 * @param {Record<string, any>} facts
 * @param {string} fallback     the Tier 2 string used when validation rejects
 * @returns {Promise<{prose: string, tier: 2|3, rejected: string[]}>}
 *   tier === 2 whenever validation rejected or the call failed. Never throws on a 429.
 */
export async function tier3Prose(ai, model, facts, fallback) {
  const downgrade = (rejected = []) => ({ prose: fallback, tier: 2, rejected });

  if (!ai || typeof ai.run !== 'function') return downgrade();

  let raw;
  try {
    const { system, user } = buildTier3Prompt(facts);
    const out = await ai.run(model, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // Sized from the Task 6 step-6 sample: at 220 gpt-oss-20b truncated the
      // 4-sentence descriptions mid-word often enough to matter (a truncated
      // sentence reads as filler and can strand a half-written number). 384 is
      // comfortably clear of a full 4-sentence spacecraft description; the
      // prompt still caps the length by asking for "two to four sentences".
      max_tokens: 384,
      temperature: 0.2,
    });
    raw = out && (out.response ?? out.result ?? out);
  } catch (_err) {
    // 429 / timeout / transport — the object stays Tier 2 and requeues.
    return downgrade();
  }

  const prose = clean(raw);
  if (prose.length < MIN_CHARS) return downgrade();

  const verdict = validateProse(prose, facts);
  if (!verdict.ok) return downgrade(verdict.rejected);

  return { prose, tier: 3, rejected: [] };
}
