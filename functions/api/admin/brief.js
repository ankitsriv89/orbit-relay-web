// Manual brief editor endpoint (plan 38 task 8).
//
//   POST /api/admin/brief  { date?: 'YYYY-MM-DD', narrative, note? }
//
// Overwrites `brief/<date>.json`'s narrative — the facts stay untouched — sets
// `narrative_source: 'manual'`, and rewrites `brief/index.json` so the archive
// selector picks up the edit immediately. `date` defaults to today (UTC),
// matching `brief/latest.json`'s own key.
//
// This duplicates small pieces of workers/orbit-ingest/src/brief.js
// (archiveKey, FORBIDDEN, cleanNarrative, rebuildIndex) rather than importing
// them — functions/ and workers/orbit-ingest/ are separate bundles with no
// shared import path, the same reason parseEpochUTC/CITATION are duplicated
// across the repo (see CLAUDE.md). Keep the two copies in sync by hand.

import { adminJson } from '../_admin.js';
import { CITATION } from '../_orbit.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BRIEF_ARCHIVE_PREFIX = 'brief/';
const BRIEF_INDEX_KEY = 'brief/index.json';
const BRIEF_INDEX_DAYS = 90;
const MIN_NARRATIVE_CHARS = 60;
const MAX_NARRATIVE_CHARS = 700;

const archiveKey = (date) => `brief/${date}.json`;

// Same legal constraint as the AI gate in workers/orbit-ingest/src/brief.js —
// conjunction assessment is the one thing this project does not redistribute.
// Manual text gets this check too; it only skips the number-grounding gate,
// which has no meaning for author-signed prose.
const FORBIDDEN = [
  /\bcollision\b/i,
  /\bcollide/i,
  /\bconjunction/i,
  /\bwill (?:hit|strike|impact)\b/i,
  /\bnear[- ]miss\b/i,
];

const LINKY = /(https?:\/\/|www\.|@[a-z0-9_]{2,})/i;

function cleanNarrative(raw) {
  let text = String(raw == null ? '' : raw).trim();
  text = text.replace(/^```[a-z]*\s*|\s*```$/g, '');
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

function checkManualNarrative(raw) {
  const text = cleanNarrative(raw);
  if (!text) return { ok: false, reason: 'narrative is empty' };
  if (text.length < MIN_NARRATIVE_CHARS) {
    return { ok: false, reason: `too short (${text.length} chars, minimum ${MIN_NARRATIVE_CHARS})` };
  }
  if (text.length > MAX_NARRATIVE_CHARS) {
    return { ok: false, reason: `too long (${text.length} chars, maximum ${MAX_NARRATIVE_CHARS})` };
  }
  if (LINKY.test(text)) return { ok: false, reason: 'narrative contains a link or handle' };
  for (const pattern of FORBIDDEN) {
    if (pattern.test(text)) {
      return { ok: false, reason: `narrative makes a conjunction/collision claim (matches ${pattern})` };
    }
  }
  return { ok: true, text };
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ORBIT_R2) {
    return adminJson({ error: 'Artifact store not bound — ORBIT_R2 binding is missing on this deployment.' }, 503);
  }

  let body;
  try { body = await request.json(); } catch (_) {
    return adminJson({ error: 'Request body must be valid JSON.' }, 400);
  }

  const date = body?.date == null ? new Date().toISOString().slice(0, 10) : body.date;
  if (!DATE_RE.test(date)) {
    return adminJson({ error: '`date` must be YYYY-MM-DD.' }, 400);
  }

  const verdict = checkManualNarrative(body?.narrative);
  if (!verdict.ok) return adminJson({ error: verdict.reason }, 400);

  const key = archiveKey(date);
  const existing = await env.ORBIT_R2.get(key);
  if (!existing) {
    return adminJson({ error: `No brief exists for ${date} — the auto-generated card must exist before it can be edited.` }, 404);
  }

  let card;
  try { card = JSON.parse(await existing.text()); } catch (_) {
    return adminJson({ error: `The stored brief for ${date} could not be parsed.` }, 500);
  }

  card.narrative = verdict.text;
  card.narrative_status = 'ok: manual edit';
  card.narrative_source = 'manual';
  if (body?.note != null) card.editor_note = String(body.note).slice(0, 500);

  const generatedAt = new Date().toISOString();
  await env.ORBIT_R2.put(key, JSON.stringify(card), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { citation: CITATION, generated: card.generated_at || generatedAt },
  });

  // The live page reads brief/latest.json, not the dated key — keep them in
  // sync when the edit targets today so the manual text shows up immediately
  // rather than only in the archive.
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) {
    await env.ORBIT_R2.put('brief/latest.json', JSON.stringify(card), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { citation: CITATION, generated: card.generated_at || generatedAt },
    });
  }

  await rebuildIndex(env);

  return adminJson({ ok: true, date, narrative: card.narrative, narrative_source: 'manual' });
}

/** Twin of workers/orbit-ingest/src/brief.js's rebuildIndex — see file header. */
async function rebuildIndex(env) {
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

  keys.sort().reverse();
  const capped = keys.slice(0, BRIEF_INDEX_DAYS);

  const days = [];
  for (const date of capped) {
    const obj = await env.ORBIT_R2.get(archiveKey(date));
    if (!obj) continue;
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

  const indexGeneratedAt = new Date().toISOString();
  await env.ORBIT_R2.put(BRIEF_INDEX_KEY, JSON.stringify({
    generated_at: indexGeneratedAt, total: keys.length, days,
  }), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { citation: CITATION, generated: indexGeneratedAt },
  });
}
