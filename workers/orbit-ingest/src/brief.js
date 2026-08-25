/**
 * Daily brief — the narrative card for /spacetrack/ (plan 33 wave 6).
 *
 * Built ONCE A DAY inside the ingest, stored as an R2 artifact, and read back
 * by a flat object GET. Nothing here ever runs per request: visitor traffic
 * must not be able to drive inference cost, and a model call on the read path
 * would also make the card differ between two people looking at the same page.
 *
 * ## The card is facts first, narrative second
 *
 * `collectFacts()` computes every number in SQL. The model is only ever asked
 * to *phrase* those numbers — it is never the source of one. The artifact
 * therefore carries the facts whether or not a narrative was produced, and the
 * panel renders them either way. That is what makes this wave droppable "without
 * consequence": turn the flag off and the card degrades to a plain digest rather
 * than disappearing.
 *
 * ## The grounding gate
 *
 * `checkNarrative()` rejects any narrative containing a numeral that is not in
 * the facts it was given. Not a style filter — the failure mode this wave is
 * exposed to is a fluent sentence with an invented number in it, which is
 * indistinguishable from a correct one at a glance and which nothing downstream
 * would ever catch. It is the same shape of defence as wave 5's DERIVED capture
 * gate: an assertion that makes the bad outcome impossible rather than unlikely,
 * so a regression shows up as a rejected card in the artifact instead of as
 * plausible fiction on the page.
 *
 * A useful side effect: object names come from Space-Track, so they are the one
 * piece of model input this project does not author. Even if a name were ever
 * crafted to steer the model, the gate bounds what it can make the model say to
 * a rearrangement of numbers that were already true.
 *
 * Rejection is recorded in the artifact (`narrative_status`), never silently
 * swallowed — a card that quietly stopped generating would look identical to a
 * quiet day.
 */

import { CITATION } from './derive.js';

export const BRIEF_KEY = 'brief/latest.json';
export const BRIEF_ARCHIVE_PREFIX = 'brief/';
export const BRIEF_INDEX_KEY = 'brief/index.json';

/** Hard cap on the archive index (plan 38). Older days stay reachable by `?date=`. */
export const BRIEF_INDEX_DAYS = 90;

/** `brief/<YYYY-MM-DD>.json` — the day key a card's `generated_at` maps to. */
export function archiveKey(dateStr) {
  return `brief/${dateStr}.json`;
}

/** Small, fast and free-tier eligible. Overridable via env for evaluation. */
export const BRIEF_MODEL = '@cf/meta/llama-3.1-8b-instruct';

/** The brief describes the last day, matching the once-a-day cadence. */
export const WINDOW_HOURS = 24;

/** Reentry predictions inside this horizon are "soon" enough to name. */
export const REENTRY_HORIZON_DAYS = 7;

/**
 * Length bounds. The floor rejects "No significant events." — if there is
 * nothing to say, the facts digest says it better than a sentence does. The
 * ceiling is what separates a brief from filler, which is the plan's own
 * criterion for dropping this wave.
 */
export const MIN_NARRATIVE_CHARS = 60;
export const MAX_NARRATIVE_CHARS = 700;

/**
 * The one content restriction, and it is a legal one rather than a stylistic
 * one. Conjunction assessment is the single thing this project does not
 * redistribute — CDM is absent from USSPACECOM's enumerated basic-SSA set — and
 * the only close-approach surface on the site is badged UNOFFICIAL and derived
 * in the visitor's own browser. A daily narrative asserting collision risk would
 * be an unbadged claim about exactly that excluded class.
 */
const FORBIDDEN = [
  /\bcollision\b/i,
  /\bcollide/i,
  /\bconjunction/i,
  /\bwill (?:hit|strike|impact)\b/i,
  /\bnear[- ]miss\b/i,
];

/** A narrative has no business containing a link or a handle. */
const LINKY = /(https?:\/\/|www\.|@[a-z0-9_]{2,})/i;

/* ── Facts ──────────────────────────────────────────────────────────────── */

const iso = (d) => new Date(d).toISOString();

async function rows(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

/**
 * Everything the card is allowed to state, computed in SQL.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {Date|number} [opts.now] injected so the tests are not clock-dependent
 */
export async function collectFacts(env, { now = Date.now() } = {}) {
  const db = env.ORBIT_DB;
  const nowMs = new Date(now).getTime();
  const since = iso(nowMs - WINDOW_HOURS * 3600_000);
  // Dates only — see the DECAY_EPOCH note on the reentry query below. The
  // window is bounded at BOTH ends: the `decay` table holds historical decay
  // messages as well as forward predictions (Sputnik 1 is in there, epoch
  // 1957-12-01), and an upper bound alone would put a 25,000-day-old reentry
  // at the top of a list captioned "predicted to reenter within 7 days".
  const today = iso(nowMs).slice(0, 10);
  const horizon = iso(nowMs + REENTRY_HORIZON_DAYS * 86400_000).slice(0, 10);

  const [catalogRows, newCount, decayCount, newSample, decaySample,
         newCountries, reentry] = await Promise.all([
    // ONE pass for the four catalog numbers below (tracked_on_orbit, payloads,
    // rocket_bodies, debris). This was a COUNT(*) plus an OBJECT_TYPE GROUP BY,
    // each an unindexed scan of the whole catalog — measured 2026-08-26 at
    // 259,140 rows read to return 16 (ratio 16,196), the top line in the D1
    // dashboard once the events(kind, ts) index removed the join above it.
    // Same fix as buildSummary()/buildAnalytics(); see foldAnalytics in
    // derive.js for why a GROUP BY here cannot be served by an index.
    rows(db, 'SELECT OBJECT_TYPE, DECAY_DATE FROM objects'),
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'new_object' AND ts >= ?`)
      .bind(since).first(),
    db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'decay' AND ts >= ?`)
      .bind(since).first(),
    rows(db, `SELECT e.NORAD_CAT_ID AS norad, o.OBJECT_NAME AS name,
                     o.COUNTRY_CODE AS country, o.OBJECT_TYPE AS type, o.regime AS regime
              FROM events e LEFT JOIN objects o ON o.NORAD_CAT_ID = e.NORAD_CAT_ID
              WHERE e.kind = 'new_object' AND e.ts >= ?
              ORDER BY e.ts DESC LIMIT 6`, [since]),
    rows(db, `SELECT e.NORAD_CAT_ID AS norad, e.title AS title, o.OBJECT_NAME AS name,
                     o.COUNTRY_CODE AS country
              FROM events e LEFT JOIN objects o ON o.NORAD_CAT_ID = e.NORAD_CAT_ID
              WHERE e.kind = 'decay' AND e.ts >= ?
              ORDER BY e.ts DESC LIMIT 6`, [since]),
    rows(db, `SELECT o.COUNTRY_CODE AS k, COUNT(*) AS n
              FROM events e JOIN objects o ON o.NORAD_CAT_ID = e.NORAD_CAT_ID
              WHERE e.kind = 'new_object' AND e.ts >= ? AND o.COUNTRY_CODE IS NOT NULL
              GROUP BY k ORDER BY n DESC LIMIT 3`, [since]),
    // Latest message per object, same (NORAD, MAX(MSG_EPOCH)) join the
    // decay-watch endpoint uses — a later prediction supersedes an earlier one,
    // and D1's SQLite build is not guaranteed to have window functions.
    //
    // The horizon compares the DATE PREFIX, not the whole string. DECAY_EPOCH
    // is `varchar(24)` upstream and arrives as `2026-07-26 04:12:00` — space
    // separated, no zone — so comparing it against an ISO instant would be
    // comparing two different formats and relying on ' ' sorting below 'T' to
    // come out right. It happens to, at day granularity; that is a coincidence
    // to remove rather than to depend on. `substr(...,1,10)` is the same
    // normalisation ingest-decay.js already applies.
    //
    // "Latest message per object" is a correlated NOT EXISTS — "no later
    // message exists for this NORAD" — and NOT a
    //   JOIN (SELECT NORAD_CAT_ID, MAX(MSG_EPOCH) ... GROUP BY NORAD_CAT_ID)
    // which is what used to be here. That form is correct but unplannable:
    // SQLite cannot turn it into an index walk, so it full-scanned `decay` on
    // every call — and `decay` holds Space-Track's HISTORICAL messages back to
    // Sputnik 1, not just live predictions. The identical query cost 53.67M
    // rows read at ratio 10,630 in /api/decay-watch before 3445edf8 rewrote it
    // this way; brief.js kept the old shape until 2026-08-26. NOT EXISTS walks
    // the (NORAD_CAT_ID, MSG_EPOCH) primary key instead. MSG_EPOCH sorts
    // lexically the same as chronologically (fixed-width upstream format), so
    // a raw-text '>' comparison is valid.
    rows(db, `SELECT d.NORAD_CAT_ID AS norad, d.OBJECT_NAME AS name, d.COUNTRY AS country,
                     d.DECAY_EPOCH AS decay_epoch, d.SOURCE AS source
              FROM decay d
              LEFT JOIN objects o ON o.NORAD_CAT_ID = d.NORAD_CAT_ID
              WHERE d.DECAY_EPOCH IS NOT NULL
                AND substr(d.DECAY_EPOCH, 1, 10) >= ?
                AND substr(d.DECAY_EPOCH, 1, 10) <= ?
                AND (o.DECAY_DATE IS NULL OR o.NORAD_CAT_ID IS NULL)
                -- Latest message per object: see the note above this query.
                AND NOT EXISTS (
                  SELECT 1 FROM decay d2
                  WHERE d2.NORAD_CAT_ID = d.NORAD_CAT_ID
                    AND d2.MSG_EPOCH > d.MSG_EPOCH
                )
              ORDER BY d.DECAY_EPOCH ASC LIMIT 5`, [today, horizon]),
  ]);

  // Fold the single catalog pass into the four numbers the card needs. Only
  // live rows count: every figure here is on-orbit-now, and a decayed object
  // must not inflate the type buckets above the total they are drawn from.
  let trackedLive = 0;
  const typeCounts = {};
  for (const r of catalogRows) {
    if (r.DECAY_DATE != null) continue;
    trackedLive++;
    const k = r.OBJECT_TYPE || 'UNKNOWN';
    typeCounts[k] = (typeCounts[k] || 0) + 1;
  }

  return {
    generated_at: iso(nowMs),
    window_hours: WINDOW_HOURS,
    tracked_on_orbit: trackedLive,
    payloads: typeCounts.PAYLOAD || 0,
    rocket_bodies: typeCounts['ROCKET BODY'] || 0,
    debris: typeCounts.DEBRIS || 0,
    new_objects: newCount ? newCount.n : 0,
    decays: decayCount ? decayCount.n : 0,
    new_object_sample: newSample.map((r) => ({
      norad: r.norad,
      name: r.name || `NORAD ${r.norad}`,
      country: r.country || null,
      type: r.type || null,
      regime: r.regime || null,
    })),
    decay_sample: decaySample.map((r) => ({
      norad: r.norad,
      name: r.name || r.title || `NORAD ${r.norad}`,
      country: r.country || null,
    })),
    new_object_countries: newCountries.map((r) => ({ code: r.k, n: r.n })),
    reentry_horizon_days: REENTRY_HORIZON_DAYS,
    reentry_watch: reentry.map((r) => ({
      norad: r.norad,
      name: r.name || `NORAD ${r.norad}`,
      country: r.country || null,
      decay_epoch: r.decay_epoch,
      source: r.source || null,
      days_until: daysUntil(r.decay_epoch, nowMs),
    })),
  };
}

/**
 * Parse a Space-Track epoch as UTC. Twin of `parseEpochUTC` in
 * `functions/api/_catalog.js` — the two sides of this repo cannot import from
 * each other, so `test/brief.test.mjs` asserts they agree on every case rather
 * than trusting two copies to stay in step.
 *
 * Two properties of the real values, both learned the hard way:
 *
 *  1. There is **no timezone**, and V8 reads a zone-less
 *     `2026-07-26 04:12:00` as *local* time — enough to move a `ceil()`'d day
 *     count by one on any host that is not UTC.
 *  2. **The hour is not zero-padded**: production sends `1957-12-01 0:00:00`,
 *     which is not valid ISO, so patching the string to `...T0:00:00Z` and
 *     re-parsing gives NaN. That mistake nulled every countdown on
 *     `/api/decay-watch` in production once already.
 *
 * Hence explicit components and `Date.UTC`, not a repaired string.
 */
const ST_EPOCH =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?)?$/;

export function parseEpochUTC(value) {
  if (value == null || value === '') return NaN;
  const s = String(value).trim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
  const m = ST_EPOCH.exec(s);
  if (!m) return Date.parse(s);
  return Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0),
    m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0,
  );
}

function daysUntil(epoch, nowMs) {
  const t = parseEpochUTC(epoch);
  return Number.isNaN(t) ? null : Math.ceil((t - nowMs) / 86400_000);
}

/** True when there is genuinely nothing to narrate. */
export function isQuiet(facts) {
  return !facts.new_objects && !facts.decays && !facts.reentry_watch.length;
}

/* ── Prompt ─────────────────────────────────────────────────────────────── */

const SYSTEM = [
  'You write one short factual paragraph for a satellite-tracking dashboard.',
  'Rules, all mandatory:',
  '- Use ONLY the numbers given in the data. Never compute, estimate, round or invent a number.',
  '- Do not add context, history or commentary that is not in the data.',
  '- Never mention collisions, conjunctions, close approaches or near misses.',
  '- No headings, no bullet points, no markdown, no links.',
  '- 2 to 4 sentences of plain prose. Past tense. No greeting and no sign-off.',
].join('\n');

/**
 * The facts, rendered as flat labelled lines rather than raw JSON — a small
 * instruct model follows a list of statements more reliably than it reads a
 * nested object, and every line here is one the gate can verify afterwards.
 */
export function buildPrompt(facts) {
  const lines = [
    `Objects currently on orbit: ${facts.tracked_on_orbit}`,
    `Of those, payloads: ${facts.payloads}, rocket bodies: ${facts.rocket_bodies}, debris: ${facts.debris}`,
    `Newly catalogued in the last ${facts.window_hours} hours: ${facts.new_objects}`,
    `Objects that decayed in the last ${facts.window_hours} hours: ${facts.decays}`,
  ];

  if (facts.new_object_sample.length) {
    lines.push('Examples of the new objects: ' + facts.new_object_sample
      .map((o) => `${o.name} (catalog number ${o.norad}${o.country ? `, registered to ${o.country}` : ''}${o.regime ? `, ${o.regime}` : ''})`)
      .join('; '));
  }
  if (facts.new_object_countries.length) {
    lines.push('New objects by registering state: ' + facts.new_object_countries
      .map((c) => `${c.code} ${c.n}`).join(', '));
  }
  if (facts.decay_sample.length) {
    lines.push('Objects that came down: ' + facts.decay_sample
      .map((o) => `${o.name} (catalog number ${o.norad})`).join('; '));
  }
  if (facts.reentry_watch.length) {
    lines.push(`Predicted to reenter within ${facts.reentry_horizon_days} days: ` +
      facts.reentry_watch
        .map((o) => `${o.name} (catalog number ${o.norad}, in about ${o.days_until} days)`)
        .join('; '));
  } else {
    lines.push(`No reentries are predicted within the next ${facts.reentry_horizon_days} days.`);
  }

  return {
    system: SYSTEM,
    user: `Data for ${facts.generated_at.slice(0, 10)}:\n${lines.join('\n')}\n\n` +
          'Write the paragraph.',
  };
}

/* ── The grounding gate ─────────────────────────────────────────────────── */

/** Numbers, with optional thousands separators and an optional decimal part. */
const NUMERAL = /\d[\d,]*(?:\.\d+)?/g;

const normalise = (token) => token.replace(/,/g, '');

/**
 * Every numeral string the narrative is permitted to contain.
 *
 * Walks the facts, taking numbers from values *and* from inside strings — a
 * name like "STARLINK-1234" or an epoch like "2026-07-28" legitimately puts
 * digits in the model's input, and the model quoting them back is correct.
 * Both the literal form and `Number()`'s form are added so a zero-padded "07"
 * in a date still admits a bare "7".
 */
export function allowedNumerals(facts) {
  const allowed = new Set();

  const addToken = (token) => {
    const t = normalise(token);
    allowed.add(t);
    const n = Number(t);
    if (Number.isFinite(n)) allowed.add(String(n));
  };

  const walk = (node) => {
    if (node == null) return;
    if (typeof node === 'number') { addToken(String(node)); return; }
    if (typeof node === 'string') {
      for (const m of node.match(NUMERAL) || []) addToken(m);
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') { Object.values(node).forEach(walk); }
  };

  walk(facts);
  return allowed;
}

/**
 * Decide whether a generated narrative may be published.
 *
 * @returns {{ok: boolean, reason: string|null, text: string}}
 */
export function checkNarrative(raw, facts) {
  const text = cleanNarrative(raw);
  const fail = (reason) => ({ ok: false, reason, text });

  if (!text) return fail('empty');
  if (text.length < MIN_NARRATIVE_CHARS) return fail(`too short (${text.length} chars)`);
  if (text.length > MAX_NARRATIVE_CHARS) return fail(`too long (${text.length} chars)`);
  if (LINKY.test(text)) return fail('contains a link or handle');

  for (const pattern of FORBIDDEN) {
    if (pattern.test(text)) return fail(`makes a conjunction/collision claim (${pattern})`);
  }

  const allowed = allowedNumerals(facts);
  for (const token of text.match(NUMERAL) || []) {
    if (!allowed.has(normalise(token))) {
      return fail(`unsupported number "${token}" — not present in the facts`);
    }
  }

  return { ok: true, reason: null, text };
}

/**
 * Strip the wrappers small instruct models add anyway — a leading "Here is the
 * paragraph:", surrounding quotes, markdown emphasis, bullet marks. Removing
 * them is not the same as tolerating them: what is left still has to pass every
 * check above.
 */
export function cleanNarrative(raw) {
  let text = String(raw == null ? '' : raw).trim();
  text = text.replace(/^```[a-z]*\s*|\s*```$/g, '');
  text = text.replace(/^(?:here(?:'s| is)[^:\n]*:\s*)/i, '');
  text = text.replace(/^#+\s*/gm, '');
  text = text.replace(/^[-*•]\s+/gm, '');
  text = text.replace(/\*\*|__|\*|_/g, '');
  text = text.replace(/\s*\n+\s*/g, ' ');
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text.length > 1 && /^["'“”]/.test(text) && /["'“”]$/.test(text)) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/* ── Assembly ───────────────────────────────────────────────────────────── */

/** The flag is opt-in: no inference happens anywhere until it is set. */
export function cardsEnabled(env) {
  const flag = env && env.ORBIT_AI_CARDS;
  return flag === true || flag === '1' || flag === 'true';
}

/**
 * Build `brief/latest.json` (+ the day's archive card and index) and write
 * them to R2.
 *
 * The artifact is written whether or not a narrative survived, because the
 * facts are the useful part and a stale card is worse than a plain one.
 *
 * `narrative_source` is separate from `narrative_status`: status is the
 * detailed outcome of *this build* (ok / rejected: reason / error: … /
 * disabled / skipped …), while source is the three-way the UI badges —
 * `'ai'` once a narrative actually clears the gate, `'none'` for every other
 * outcome here. A manual edit (plan 38 task 8, `/api/admin/brief`) is the only
 * path that ever writes `'manual'`; nothing in this build ever does.
 */
export async function buildBrief(env, { now = Date.now() } = {}) {
  const facts = await collectFacts(env, { now });

  const card = {
    generated_at: facts.generated_at,
    citation: CITATION,
    window_hours: WINDOW_HOURS,
    facts,
    narrative: null,
    narrative_status: 'disabled',
    narrative_source: 'none',
    model: null,
    // The panel says this out loud. A machine-written sentence on a page of
    // measured numbers has to be labelled as one.
    disclaimer: 'Narrative generated from the figures above by a language model, ' +
                'once per day. Every number is computed from the catalog, not by the model.',
  };

  if (!cardsEnabled(env)) return finish(env, card);
  if (!env.ORBIT_AI || typeof env.ORBIT_AI.run !== 'function') {
    card.narrative_status = 'unavailable: no AI binding';
    return finish(env, card);
  }
  if (isQuiet(facts)) {
    // Nothing happened. Asking a model to say so produces filler by definition.
    card.narrative_status = 'skipped: nothing to report';
    return finish(env, card);
  }

  const model = env.ORBIT_AI_MODEL || BRIEF_MODEL;
  const { system, user } = buildPrompt(facts);

  try {
    const out = await env.ORBIT_AI.run(model, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // Enough for four sentences and not enough for an essay; low temperature
      // because the job is phrasing, not invention.
      max_tokens: 260,
      temperature: 0.2,
    });

    const verdict = checkNarrative(out && (out.response ?? out.result ?? out), facts);
    card.model = model;
    if (verdict.ok) {
      card.narrative = verdict.text;
      card.narrative_status = 'ok';
      card.narrative_source = 'ai';
    } else {
      card.narrative_status = `rejected: ${verdict.reason}`;
      // The text stays out of the public artifact but goes to the run log, which
      // is where you look when the card stops appearing.
      console.warn(`[orbit-brief] rejected (${verdict.reason}):`,
                   verdict.text.slice(0, 240));
    }
  } catch (err) {
    // A model outage must not fail the ingest — the facts are already good.
    card.narrative_status = `error: ${String(err && err.message || err)}`.slice(0, 200);
    console.warn('[orbit-brief] generation failed:', err);
  }

  return finish(env, card);
}

/**
 * Write `latest.json`, the day's archive card, and rebuild the index.
 *
 * The archive/index writes are wrapped separately from `put()` and never
 * throw: losing a day from the archive is a gap in a list, losing
 * `latest.json` is the live page going blank. The two must not share a
 * failure mode.
 */
async function finish(env, card) {
  await put(env, card);
  try {
    await putArchiveDay(env, card);
    await rebuildIndex(env);
  } catch (err) {
    console.warn('[orbit-brief] archive write failed:', err);
  }
  return card;
}

/** Write `brief/<date>.json` — the same card, keyed by the day it narrates. */
async function putArchiveDay(env, card) {
  const date = card.generated_at.slice(0, 10);
  await env.ORBIT_R2.put(archiveKey(date), JSON.stringify(card), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { citation: CITATION, generated: card.generated_at },
  });
}

/**
 * Rebuild `brief/index.json` from an R2 `list()` prefix scan — never by
 * appending to the previous index. If a day's card write succeeds and an
 * append-based index write then fails, that day is permanently missing from
 * an appended index: a silent gap. A prefix-scan rebuild self-heals on the
 * next successful run, because it is recomputed from what R2 actually holds
 * rather than from what the last index write remembered.
 */
export async function rebuildIndex(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.ORBIT_R2.list({ prefix: BRIEF_ARCHIVE_PREFIX, cursor });
    for (const obj of page.objects || []) {
      const m = /^brief\/(\d{4}-\d{2}-\d{2})\.json$/.exec(obj.key);
      if (m) keys.push(m[1]);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  keys.sort().reverse(); // newest first
  const capped = keys.slice(0, BRIEF_INDEX_DAYS);

  const days = [];
  for (const date of capped) {
    const obj = await env.ORBIT_R2.get(archiveKey(date));
    if (!obj) continue; // listed but unreadable — skip rather than fail the index
    let day;
    try { day = JSON.parse(await obj.text()); } catch (_) { continue; }
    days.push({
      date,
      new_objects: day.facts ? day.facts.new_objects : 0,
      decays: day.facts ? day.facts.decays : 0,
      narrative_source: day.narrative_source || 'none',
      headline: day.narrative
        ? day.narrative.split(/(?<=[.!?])\s+/)[0]
        : null,
    });
  }

  const index = { generated_at: new Date().toISOString(), total: keys.length, days };
  await env.ORBIT_R2.put(BRIEF_INDEX_KEY, JSON.stringify(index), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { citation: CITATION, generated: index.generated_at },
  });
  return index;
}

async function put(env, card) {
  await env.ORBIT_R2.put(BRIEF_KEY, JSON.stringify(card), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { citation: CITATION, generated: card.generated_at },
  });
  return card;
}
