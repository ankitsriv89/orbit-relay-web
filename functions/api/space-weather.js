// Cloudflare Pages Function — NOAA SWPC space weather (plan 34 §3.4).
//
//   GET /api/space-weather
//
// A flat R2 read of `space-weather/latest.json`, which the daily ingest
// regenerates from SWPC's open JSON endpoints (3-hour Kp history, 3-day Kp
// forecast, F10.7 cm flux). This is the ONE endpoint whose body carries no
// Space-Track data, so the X-Data-Source header carries the SWPC attribution
// instead — see `json()`'s `citation` option in _catalog.js. The body itself
// ships `swpc_citation` on both the artifact and the D1-fallback path.
//
// It falls back to reassembling the same shape from the `space_weather` table
// when the artifact is missing — the state between applying the schema and
// the first daily run.

import { json, preflight, artifactOrDb, requireDb, safeParse } from './_catalog.js';
import { SWPC_CITATION } from './_orbit.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return preflight();

  return artifactOrDb(env, 'space-weather/latest.json', 900, async () => {
    const unbound = requireDb(env);
    if (unbound) return unbound;

    const { results } = await env.ORBIT_DB.prepare(
      'SELECT kind, time_tag, value, meta FROM space_weather ORDER BY time_tag').all();

    return {
      ...rebuildFromRows(results || []),
      stale: true,
      note: 'Space-weather artifact not built yet — read from D1.',
    };
  }, (a) => a, { citation: SWPC_CITATION });
}

/**
 * Reassemble the artifact shape from `space_weather` rows — the D1 fallback.
 * Exported so space-weather.test.mjs can pin it against the ingest's
 * `buildSpaceWeatherArtifact` (two bundles, one contract, tested rather than
 * trusted, same discipline as the CITATION duplication).
 */
export function rebuildFromRows(rows) {
  const kp3h = [];
  const forecast = [];
  const f107 = [];
  for (const r of rows || []) {
    const meta = safeParse(r.meta) || {};
    if (r.kind === 'kp_3h') {
      kp3h.push({
        time_tag: r.time_tag,
        kp: r.value,
        ap: meta.ap ?? null,
        station_count: meta.station_count ?? null,
      });
    } else if (r.kind === 'kp_forecast') {
      forecast.push({
        time_tag: r.time_tag,
        kp: r.value,
        observed: meta.observed ?? false,
      });
    } else if (r.kind === 'f107') {
      f107.push({
        time_tag: r.time_tag,
        flux: r.value,
        ninety_day_mean: meta.ninety_day_mean ?? null,
      });
    }
  }

  const latestKp = kp3h[kp3h.length - 1] || null;
  const latestF107 = f107[f107.length - 1] || null;
  // Mirrors buildSpaceWeatherArtifact: the 90-day mean is the latest row that
  // carries one, not the latest row's field (SWPC omits it on some reports).
  const lastWith = (rows, field) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][field] != null) return rows[i][field];
    }
    return null;
  };
  return {
    generated_at: new Date().toISOString(),
    swpc_citation: SWPC_CITATION,
    current: {
      time_tag: latestKp ? latestKp.time_tag : null,
      kp: latestKp ? latestKp.kp : null,
      ap: latestKp ? latestKp.ap : null,
      station_count: latestKp ? latestKp.station_count : null,
      f107: latestF107 ? latestF107.flux : null,
      f107_90day: lastWith(f107, 'ninety_day_mean'),
    },
    kp_history: kp3h.map((r) => ({ t: r.time_tag, kp: r.kp })),
    kp_forecast: forecast.map((r) => ({ t: r.time_tag, kp: r.kp, observed: r.observed })),
    f107: latestF107
      ? { time_tag: latestF107.time_tag, flux: latestF107.flux, ninety_day_mean: latestF107.ninety_day_mean }
      : null,
  };
}
