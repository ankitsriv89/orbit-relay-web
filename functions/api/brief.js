// Cloudflare Pages Function — the daily brief for /spacetrack/ (plan 33 wave 6,
// archive reads added plan 38 task 6).
//
//   GET /api/brief             → brief/latest.json
//   GET /api/brief?date=YYYY-MM-DD → brief/<date>.json
//   GET /api/brief?index        → brief/index.json (last 90 days)
//
// All three are flat R2 object reads. Same discipline as summary.js and the
// fast path of feed.js.
//
// **There is deliberately no D1 fallback here, for any of the three reads,
// unlike feed.js.** Two reasons, and both are the point of the wave rather
// than an omission:
//
//   1. The narrative cannot be regenerated on a read. Inference on the read
//      path is exactly what wave 6 is designed to prevent — it would let
//      visitor traffic drive cost, and it would make the card differ between
//      two people looking at the same page on the same day.
//   2. A facts-only fallback computed at request time would be *worse than
//      nothing*. The card's whole guarantee is that its prose was checked
//      against the facts it was generated from; recomputing the facts hours
//      later and pairing them with yesterday's sentence quietly breaks exactly
//      the property the grounding gate exists to hold.
//
// So a missing artifact — today's, an archived day's, or the index — is
// reported as missing. 200 rather than 404, because "not built yet" is a
// normal state on a fresh deployment or for a day that predates the archive,
// and the panel should render a hint rather than treat it as an error.

import { json, preflight, withCitation } from './_catalog.js';

const BRIEF_KEY = 'brief/latest.json';
const BRIEF_INDEX_KEY = 'brief/index.json';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const archiveKey = (date) => `brief/${date}.json`;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  if (!env || !env.ORBIT_R2) {
    return json(withCitation(unavailable('The orbit artifact store is not configured on this deployment.')),
                { maxAge: 60 });
  }

  const url = new URL(request.url);
  if (url.searchParams.has('index')) return handleIndex(env);

  const date = url.searchParams.get('date');
  if (date != null) {
    if (!DATE_RE.test(date)) {
      return json(withCitation({ ...unavailable('`date` must be YYYY-MM-DD.'), date }),
                  { status: 400 });
    }
    return handleCard(env, archiveKey(date), 'No brief was built for that day.');
  }

  return handleCard(env, BRIEF_KEY, 'No brief has been built yet — the ingest writes one once a day.');
}

async function handleCard(env, key, missingNote) {
  const object = await env.ORBIT_R2.get(key);
  if (!object) {
    return json(withCitation(unavailable(missingNote)), { maxAge: 60 });
  }

  try {
    const card = JSON.parse(await object.text());
    return json(withCitation({ ...card, available: true }), { maxAge: 300 });
  } catch (_) {
    // A corrupt artifact is reported, not papered over: there is nothing else
    // to serve, and a silent empty card is indistinguishable from a quiet day.
    return json(withCitation(unavailable('The brief artifact could not be parsed.')), { maxAge: 60 });
  }
}

async function handleIndex(env) {
  const object = await env.ORBIT_R2.get(BRIEF_INDEX_KEY);
  if (!object) {
    return json(withCitation({ available: false, total: 0, days: [],
                               note: 'No brief archive has been built yet.' }),
                { maxAge: 60 });
  }

  try {
    const index = JSON.parse(await object.text());
    return json(withCitation({ ...index, available: true }), { maxAge: 300 });
  } catch (_) {
    return json(withCitation({ available: false, total: 0, days: [],
                               note: 'The brief index could not be parsed.' }),
                { maxAge: 60 });
  }
}

const unavailable = (note) => ({
  available: false,
  generated_at: null,
  facts: null,
  narrative: null,
  narrative_status: 'unavailable',
  note,
});
