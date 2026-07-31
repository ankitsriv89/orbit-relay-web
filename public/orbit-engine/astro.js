/**
 * Orbital arithmetic. No Cesium, no DOM — just satellite.js and maths.
 *
 * Split out in plan 33 wave 3 so `/orbit/` and `/spacetrack/` share one copy.
 * The engine these belong to has now been fixed twice in two copies (the
 * marsapiens/standalone divergence that opened plan 33); a second copy inside
 * one repo would be the same mistake at closer range.
 *
 * `satellite` is the global from the vendored satellite.min.js.
 */

export const EARTH_R_KM = 6371;
export const GM_EARTH   = 398600.4418;   // km^3/s^2

/**
 * Sub-satellite point at `date`.
 *
 * Writes into `out` when given. The propagation tick calls this once per
 * visible satellite, so on that path a fresh {lat,lon,alt} per call is the
 * allocation that matters — callers reusing a scratch object must copy the
 * values out before the next call.
 *
 * @returns {{lat:number, lon:number, alt:number}|null} alt in km, null if the
 *          propagator diverged (decayed objects do this)
 */
export function geoAt(satrec, date, out) {
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = satellite.gstime(date);
    const geo  = satellite.eciToGeodetic(pv.position, gmst);
    const r = out || { lat: 0, lon: 0, alt: 0 };
    r.lat = satellite.degreesLat(geo.latitude);
    r.lon = satellite.degreesLong(geo.longitude);
    r.alt = geo.height;   // km
    return r;
}

export function orbitalPeriodMin(satrec) {
    return (2 * Math.PI) / satrec.no;
}

/**
 * Regime from altitude — the *display* classification for a live point.
 *
 * Deliberately not the same test as the ingest's `regimeOf()` in
 * workers/orbit-ingest/src/derive.js, which classifies a catalog row from its
 * PERIOD and eccentricity using Space-Track's own thresholds. This one has only
 * an instantaneous altitude to work with, so it cannot see eccentricity and
 * would call a Molniya "MEO" at apogee. Where a catalog row is available —
 * every object on /spacetrack/ — prefer the stored `regime`.
 */
export function orbitRegime(altKm) {
    if (altKm < 2000)  return 'LEO';
    if (altKm < 35000) return 'MEO';
    if (altKm < 37000) return 'GEO';
    return 'HEO';
}

/** Circular orbital speed at altitude, km/s. */
export function orbVel(altKm) {
    return Math.sqrt(GM_EARTH / (EARTH_R_KM + altKm));
}

/** Coverage footprint radius in metres — the horizon circle for a sat at altKm. */
export function footprintRadiusM(altKm) {
    // Central angle of the visible horizon: acos(R / (R + h)).
    const ratio = EARTH_R_KM / (EARTH_R_KM + altKm);
    const theta = Math.acos(Math.min(1, Math.max(-1, ratio)));
    return theta * EARTH_R_KM * 1000;    // arc length on the surface
}

export const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
export const fmtLon = (lon) => `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;
