/**
 * Space-weather ingest — NOAA SWPC indices (plan 34 §3.4), once a day in the
 * daily job beside boxscore.
 *
 * The one non-Space-Track dataset in the pipeline, and deliberately shaped
 * like `ingest-boxscore.js`: small, self-contained series that SWPC re-issues
 * in full on every fetch, so each `kind` is truncate-and-reloaded rather than
 * diffed, and an empty upstream response replaces nothing (a bad SWPC day
 * must not wipe the panel).
 *
 * Three series are pulled (all verified live against the real endpoints):
 *
 *   kp_3h        the 3-hour planetary K index — `Kp`, `a_running`,
 *                `station_count` per 3-hour bucket, ~2 weeks of history.
 *                The headline "how geomagnetic is it right now" number.
 *   kp_forecast  the 3-day Kp forecast — observed AND forecast rows in one
 *                file, told apart by `observed` ('observed' | 'forecast').
 *   f107         the F10.7 cm solar flux in sfu, a few observations a day;
 *                the 90-day mean is the drag/atmosphere proxy.
 *
 * The 1-minute Kp file is deliberately NOT ingested: 1440 rows/day of
 * 1-minute samples buy nothing a daily job can use, and the 3-hour series is
 * the authoritative planetary index.
 *
 * Unlike Space-Track there is no auth, no session and no api_calls logging —
 * that table is Space-Track's budget rail, and services.swpc.noaa.gov is an
 * open public endpoint with no documented ceiling. `fetch` is injected so the
 * test suite never touches the network, the same way `query()` is faked for
 * the Space-Track ingests.
 */

import { SWPC_CITATION } from './derive.js';

export const SWPC_BASE = 'https://services.swpc.noaa.gov';
export const SWPC_KP_3H  = `${SWPC_BASE}/products/noaa-planetary-k-index.json`;
export const SWPC_KP_FOR = `${SWPC_BASE}/products/noaa-planetary-k-index-forecast.json`;
export const SWPC_F107   = `${SWPC_BASE}/json/f107_cm_flux.json`;

/** How much 3-hour Kp history the artifact carries (one row per 3h bucket). */
export const KP_HISTORY_DAYS = 7;

/* ── Pure reducers ──────────────────────────────────────────────────────────
 * Each takes SWPC's raw JSON rows and returns the reduced shape the D1 table
 * and the R2 artifact actually store. All numeric coercion happens here —
 * SWPC emits numbers in practice, but this pipeline's other provider taught
 * it to treat upstream scalars as strings until proven otherwise.
 */

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * SWPC's time_tag is zero-padded ISO-8601 without a zone
 * ("2026-08-07T17:59:00"). Appending Z is deterministic — the leading-zero
 * trap that bit Space-Track's DECAY_EPOCH does not apply — and yields a
 * comparable millisecond value. Stored strings stay verbatim.
 */
const utcMs = (t) => Date.parse(String(t).replace(' ', 'T') + 'Z');

/**
 * @param {Array} rows  the 3h file: {time_tag, Kp, a_running, station_count}
 * @param {object} [opts]
 * @param {number} [opts.nowMs]  injection point for tests
 * @param {number} [opts.keepDays]
 * @returns {Array<{time_tag: string, kp: number, ap: number, station_count: number}>}
 *   oldest first; rows older than `keepDays` dropped
 */
export function reduceKp3h(rows, { nowMs = Date.now(), keepDays = KP_HISTORY_DAYS } = {}) {
  const cutoff = nowMs - keepDays * 86400000;
  const out = [];
  for (const r of rows || []) {
    const t = r.time_tag;
    if (!t || utcMs(t) < cutoff) continue;
    out.push({
      time_tag: String(t),
      kp: num(r.Kp),
      ap: num(r.a_running),
      station_count: num(r.station_count),
    });
  }
  out.sort((a, b) => (a.time_tag < b.time_tag ? -1 : 1));
  return out;
}

/**
 * @param {Array} rows  the forecast file: {time_tag, kp, observed, noaa_scale}
 * @returns {Array<{time_tag: string, kp: number, observed: boolean, noaa_scale: number|null}>}
 */
export function reduceKpForecast(rows) {
  return (rows || [])
    .filter((r) => r.time_tag)
    .map((r) => ({
      time_tag: String(r.time_tag),
      kp: num(r.kp),
      observed: r.observed === 'observed',
      noaa_scale: num(r.noaa_scale),
    }))
    .sort((a, b) => (a.time_tag < b.time_tag ? -1 : 1));
}

/**
 * @param {Array} rows  the F10.7 file: {time_tag, flux, ninety_day_mean}
 * @returns {Array<{time_tag: string, flux: number, ninety_day_mean: number|null}>}
 *   oldest first — the caller takes the latest for `current`.
 */
export function reduceF107(rows) {
  return (rows || [])
    .filter((r) => r.time_tag && num(r.flux) != null)
    .map((r) => ({
      time_tag: String(r.time_tag),
      flux: num(r.flux),
      ninety_day_mean: num(r.ninety_day_mean),
    }))
    .sort((a, b) => (a.time_tag < b.time_tag ? -1 : 1));
}

/**
 * The `space-weather/latest.json` artifact shape — the contract the endpoint
 * serves and the frontend renders. `current` folds the latest 3h Kp row and
 * the latest F10.7 observation into one headline object; a missing series
 * leaves its fields null rather than dropping the key (the panel must know a
 * field is absent, not silently re-flow).
 *
 * `f107_90day` is NOT the latest row's field: SWPC only attaches the 90-day
 * mean to some reports (the Noon one), so the latest observation often has
 * `ninety_day_mean: null`. The mean moves once a day, so the correct value is
 * the most recent row that carries one.
 */
export function buildSpaceWeatherArtifact({ kp3h, forecast, f107, generatedAt = new Date().toISOString() }) {
  const latestKp = kp3h && kp3h.length ? kp3h[kp3h.length - 1] : null;
  const latestF107 = f107 && f107.length ? f107[f107.length - 1] : null;
  const lastWith = (rows, field) => {
    for (let i = (rows || []).length - 1; i >= 0; i--) {
      if (rows[i][field] != null) return rows[i][field];
    }
    return null;
  };
  return {
    generated_at: generatedAt,
    swpc_citation: SWPC_CITATION,
    current: {
      time_tag: latestKp ? latestKp.time_tag : null,
      kp: latestKp ? latestKp.kp : null,
      ap: latestKp ? latestKp.ap : null,
      station_count: latestKp ? latestKp.station_count : null,
      f107: latestF107 ? latestF107.flux : null,
      f107_90day: lastWith(f107, 'ninety_day_mean'),
    },
    kp_history: (kp3h || []).map((r) => ({ t: r.time_tag, kp: r.kp })),
    kp_forecast: (forecast || []).map((r) => ({
      t: r.time_tag, kp: r.kp, observed: r.observed,
    })),
    f107: latestF107
      ? { time_tag: latestF107.time_tag, flux: latestF107.flux, ninety_day_mean: latestF107.ninety_day_mean }
      : null,
  };
}

/* ── Ingest ─────────────────────────────────────────────────────────────── */

async function fetchJson(url, fetchImpl) {
  const resp = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`SWPC ${url} failed: ${resp.status} ${resp.statusText}`);
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) {
    throw new Error(`SWPC ${url} returned non-JSON (${text.slice(0, 120)})`);
  }
  if (!Array.isArray(parsed)) throw new Error(`SWPC ${url} returned a non-array payload`);
  return parsed;
}

/**
 * Pull the three SWPC series, replace each kind's rows in D1, and rewrite
 * the R2 artifact. Each series is fetched and persisted independently — a
 * forecast outage must not cost the observed Kp, the same partial-data-beats-
 * skipped-run discipline as the rest of the daily job.
 *
 * @returns {Promise<{rows: number, kinds: Record<string, number>}>}
 */
export async function ingestSpaceWeather(env, { fetchImpl = fetch } = {}) {
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const fetches = [
    ['kp_3h', SWPC_KP_3H, (rows) => reduceKp3h(rows, { nowMs })],
    ['kp_forecast', SWPC_KP_FOR, reduceKpForecast],
    ['f107', SWPC_F107, reduceF107],
  ];

  const reduced = {};
  const errors = [];
  for (const [kind, url, reducer] of fetches) {
    try {
      const rows = reducer(await fetchJson(url, fetchImpl));
      reduced[kind] = rows;
    } catch (err) {
      errors.push(String(err && err.message || err));
      reduced[kind] = [];
    }
  }

  const rows = reduced.kp_3h.length + reduced.kp_forecast.length + reduced.f107.length;
  if (!rows) {
    // All three upstreams failed. Nothing is written — the previous artifact
    // and table rows must stay in place so the panel degrades to stale data
    // rather than to a blank panel. `errors` is reported, not thrown, so the
    // daily job's other steps are unaffected either way.
    console.error('[orbit-ingest] ingestSpaceWeather: all upstream fetches failed:', errors);
    return { rows: 0, kinds: {}, errors };
  }

  const stmts = [];
  const kinds = {};
  for (const [kind, series] of Object.entries(reduced)) {
    if (!series.length) continue;
    kinds[kind] = series.length;
    stmts.push(env.ORBIT_DB.prepare('DELETE FROM space_weather WHERE kind = ?').bind(kind));
    for (const r of series) {
      const meta = {};
      if (kind === 'kp_3h') {
        meta.ap = r.ap;
        meta.station_count = r.station_count;
      } else if (kind === 'kp_forecast') {
        meta.observed = r.observed;
        meta.noaa_scale = r.noaa_scale;
      } else if (kind === 'f107') {
        meta.ninety_day_mean = r.ninety_day_mean;
      }
      stmts.push(env.ORBIT_DB.prepare(
        'INSERT INTO space_weather (kind, time_tag, value, meta, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(kind, r.time_tag, kind === 'kp_3h' || kind === 'kp_forecast' ? r.kp : r.flux,
          JSON.stringify(meta), now));
    }
  }
  // Delete + reload per kind in ONE batch: D1 runs a batch as a transaction,
  // so a failure mid-reload rolls back rather than leaving the kind half-empty.
  if (stmts.length) await env.ORBIT_DB.batch(stmts);

  const artifact = buildSpaceWeatherArtifact({
    kp3h: reduced.kp_3h,
    forecast: reduced.kp_forecast,
    f107: reduced.f107,
    generatedAt: now,
  });
  await env.ORBIT_R2.put('space-weather/latest.json', JSON.stringify(artifact), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
  });

  return { rows, kinds, errors };
}
