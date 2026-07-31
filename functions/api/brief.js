// Cloudflare Pages Function — the daily brief for /spacetrack/ (plan 33 wave 6).
//
//   GET /api/brief
//
// A flat R2 object read of `brief/latest.json`, which the ingest writes once a
// day. Same discipline as summary.js and the fast path of feed.js.
//
// **There is deliberately no fallback here, unlike feed.js.** Two reasons, and
// both are the point of the wave rather than an omission:
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
// So a missing artifact is reported as missing. 200 rather than 404, because
// "not built yet" is a normal state on a fresh deployment and the panel should
// render a hint rather than treat it as an error.

import { json, preflight } from './_catalog.js';

const BRIEF_KEY = 'brief/latest.json';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  if (!env || !env.ORBIT_R2) {
    return json(unavailable('The orbit artifact store is not configured on this deployment.'),
                { maxAge: 60 });
  }

  const object = await env.ORBIT_R2.get(BRIEF_KEY);
  if (!object) {
    return json(unavailable('No brief has been built yet — the ingest writes one once a day.'),
                { maxAge: 60 });
  }

  try {
    const card = JSON.parse(await object.text());
    return json({ ...card, available: true }, { maxAge: 300 });
  } catch (_) {
    // A corrupt artifact is reported, not papered over: there is nothing else
    // to serve, and a silent empty card is indistinguishable from a quiet day.
    return json(unavailable('The brief artifact could not be parsed.'), { maxAge: 60 });
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
