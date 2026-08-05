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

/** Sun's apparent angular radius as seen from Earth, radians (0.266°). */
export const SUN_ANGULAR_RADIUS_RAD = 0.266 * Math.PI / 180;

/**
 * How sunlit a satellite is, in Earth's shadow (plan 34 §3.3 — eclipse shading).
 *
 * The cinematic pass needs satellites crossing Earth's shadow to dim: against
 * the night side, a fully-bright dot is the one thing on screen that the
 * day/night terminator does not explain. Cesium's built-in globe lighting
 * shades the *surface*; nothing shades the PointPrimitives this engine renders.
 *
 * Model: the shadow cylinder (solar rays are effectively parallel at this
 * scale), axis = the sun direction `sun` as seen from Earth's centre. A point
 * `p` on the day side (`p·ŝ ≥ 0`) is lit. On the night side it is lit only
 * outside the cylinder; inside the *umbra* (perpendicular distance from the
 * axis less than `earthR − band`) it is eclipsed. The `band` between full
 * umbra and full light is the penumbra, and it grows with `L`, the distance
 * behind the terminator plane: the sun is a disk, not a point, so rays
 * grazing Earth's limb converge at half-angle `SUN_ANGULAR_RADIUS_RAD`, and
 * `band = L · tan(θ_sun)` (≈ 195 km for a satellite behind GEO, ≈ 5 km for a
 * LEO sat 1,000 km past the terminator).
 *
 * Graded rather than binary on purpose, the same call `farSideFade` makes: a
 * two-state fade pops every satellite crossing the shadow boundary, and with
 * thousands of points there is always one crossing. The smoothstep across the
 * penumbra is continuous at both edges.
 *
 * Units: `p` and `sun` must share a unit system; `earthR` is in that same
 * system. The engine's positions are Earth-fixed metres, so the default is
 * `EARTH_R_KM * 1000`. The cylinder model holds while the umbra radius
 * `earthR − band` stays positive, i.e. `L < earthR / tan(θ_sun)` — ~1.37
 * million km, far beyond any orbit these pages render (the camera itself is
 * capped at 110,000 km).
 *
 * @param {{x:number,y:number,z:number}} p   satellite position from Earth's centre
 * @param {{x:number,y:number,z:number}} sun sun position from Earth's centre
 * @param {object} [o]
 * @param {number} [o.earthR] Earth radius in the same unit system as `p`
 * @returns {number} illumination factor in [0, 1]: 1 = fully sunlit,
 *                   0 = fully inside the umbra, graded across the penumbra
 */
export function eclipseShadowFactor(p, sun, { earthR = EARTH_R_KM * 1000 } = {}) {
    const sunMag = Math.hypot(sun.x, sun.y, sun.z);
    if (sunMag === 0) return 1;                       // no sun → nothing casts a shadow
    const sx = sun.x / sunMag, sy = sun.y / sunMag, sz = sun.z / sunMag;
    const along = p.x * sx + p.y * sy + p.z * sz;
    if (along >= 0) return 1;                         // day side, incl. the terminator
    const perp2 = Math.max(0, p.x * p.x + p.y * p.y + p.z * p.z - along * along);
    const perp  = Math.sqrt(perp2);                   // distance from the shadow axis
    const band  = -along * Math.tan(SUN_ANGULAR_RADIUS_RAD);
    if (perp >= earthR + band) return 1;              // outside the penumbra
    if (perp <= earthR - band) return 0;              // full umbra
    const t = (perp - (earthR - band)) / (2 * band);
    return t * t * (3 - 2 * t);                       // smoothstep across the penumbra
}

export const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}`;
export const fmtLon = (lon) => `${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`;

/* ── Far-side occlusion ─────────────────────────────────────────────────── */

/**
 * Is a point hidden behind the Earth, seen from `cam`?
 *
 * Satellite points carry `disableDepthTestDistance: Infinity` so they never
 * z-fight the globe or sink into terrain up close. The cost of that is total:
 * a satellite on the far side draws straight *through* the planet, over
 * whatever continent faces the camera. Rotating the globe then looks like the
 * dots stayed put while the map slid beneath them — the positions are right,
 * but with no depth cue the eye puts a far-side satellite on near-side ground.
 *
 * The horizon test, with everything Earth-fixed and in metres. Let `c` be the
 * camera and `p` the point, both from Earth's centre, and `R` the sphere:
 *
 *     p · c < R²   ⟺   p is beyond the horizon circle seen from c
 *
 * The plane `p · c = R²` is the one through that circle. Note it is NOT the
 * plane through the centre: `p · c < 0` would only catch the far *hemisphere*
 * and leave a visor of genuinely-hidden satellites at full brightness. As
 * `|c| → ∞` the R² term vanishes relative to `p·c` and the formula degenerates
 * to the half-space test on its own, so an orthographic-ish camera needs no
 * special case.
 *
 * `EARTH_R_KM` is the mean radius, so near the poles the horizon is at worst
 * ~11 km off the WGS-84 ellipsoid — far below one pixel at any camera distance
 * these pages allow, and the visual is a fade rather than a hard clip, so a
 * sub-pixel error in the boundary cannot be seen.
 *
 * @param {{x:number,y:number,z:number}} p   point, Earth-fixed metres
 * @param {{x:number,y:number,z:number}} cam camera, Earth-fixed metres
 * @param {number} [radiusM] occluding sphere radius, metres
 * @returns {boolean} true when the Earth sits between `cam` and `p`
 */
export function isBehindEarth(p, cam, radiusM = EARTH_R_KM * 1000) {
    return (p.x * cam.x + p.y * cam.y + p.z * cam.z) < radiusM * radiusM;
}

/**
 * Opacity multiplier for a point at `p` seen from `cam`: 1 in front of the
 * Earth, fading toward `minAlpha` the deeper it sits behind it.
 *
 * Graded rather than binary on purpose. A two-state fade makes every satellite
 * crossing the limb pop between two brightnesses, and with thousands of points
 * there is always something crossing — a ring of blinking dots at the horizon
 * during a drag, which is the same class of distraction this is meant to
 * remove. The dot product already computed *is* the depth measure, so grading
 * it costs a clamp instead of a compare.
 *
 * Depth runs from `p·c = R²` at the limb to `p·c = -|p||c|` at the antipode,
 * and it is normalised by *that span* rather than by `R²`. Normalising by `R²`
 * looks natural and is wrong: on the far side `p·c` goes to roughly `-|p||c|`,
 * which for a 50,000 km camera is ~9× `R²`, so the ratio saturates within a few
 * degrees of the limb and every hidden point lands flat on the floor — the
 * graded fade silently collapses back into the binary one. The span form keeps
 * the ramp spread across the whole hidden arc at any camera distance.
 *
 * `minAlpha` keeps far-side traffic legible — on /spacetrack/ the density *is*
 * the product, so hiding half the catalog to fix a depth cue would trade one
 * wrong impression for another.
 *
 * @param {{x:number,y:number,z:number}} p   point, Earth-fixed metres
 * @param {{x:number,y:number,z:number}} cam camera, Earth-fixed metres
 * @param {object} [o]
 * @param {number} [o.minAlpha] opacity at the antipode
 * @param {number} [o.radiusM]  occluding sphere radius, metres
 * @returns {number} multiplier in [minAlpha, 1]
 */
export function farSideFade(p, cam, { minAlpha = 0.18, radiusM = EARTH_R_KM * 1000 } = {}) {
    const rr  = radiusM * radiusM;
    const dot = p.x * cam.x + p.y * cam.y + p.z * cam.z;
    if (dot >= rr) return 1;                       // at or in front of the horizon
    // Deepest possible dot product for this point and camera: antipodal.
    const mag = Math.sqrt((p.x * p.x + p.y * p.y + p.z * p.z) *
                          (cam.x * cam.x + cam.y * cam.y + cam.z * cam.z));
    const span = rr + mag;                         // limb (rr) → antipode (-mag)
    // depth: 0 at the limb → 1 at the antipode.
    const depth = span > 0 ? Math.min(1, (rr - dot) / span) : 1;
    return minAlpha + (1 - minAlpha) * (1 - depth);
}
