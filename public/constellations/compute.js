/**
 * Constellation plane arithmetic — no satellite.js, no Cesium, no DOM.
 *
 * Plan 34 §3.2 (spec #7). The orbital-plane view groups a constellation's
 * satellites by right ascension of the ascending node into its orbital
 * planes, then draws each plane as a great-circle ring at the orbit's
 * semi-major axis. The elements every function here needs come straight off
 * a TLE: `twoline2satrec` hands the caller `nodeo` (RAAN, radians), `inclo`
 * (inclination, radians) and `no` (mean motion, rad/min). This module turns
 * those into planes and ring geometry — extracted from the DOM handlers so
 * it can be unit-tested in Node against synthetic constellations with
 * exactly-known answers, the same discipline signal/compute.js established.
 *
 * Frame conventions (documented once here, used by every function):
 *
 *  - RAAN and inclination are TLE elements — inertial values at the elset
 *    epoch. The ring drawn from them is an Earth-fixed *schematic* of the
 *    orbital plane, exactly like the GEO belt and the regime shells: it does
 *    not sweep with GMST as the plane really does, and its node line is
 *    pinned to the epoch's RAAN. Every other static ring in the product
 *    makes the same approximation; the satellites themselves propagate
 *    truthfully on top of it.
 *  - Ring frame: a point at argument of latitude u in the orbital plane is
 *    `v = r·(cos u, sin u, 0)`, placed in the Earth-fixed frame by
 *    `r = Rz(RAAN)·Rx(incl)·v`. Positive z is the north pole; positive x
 *    points at the RAAN reference.
 *
 * The plan's "group by RAAN + inclination + semi-major axis" is realised as
 * TWO-level clustering (`groupConstellation`): split members into shells by
 * inclination, then cluster each shell's RAANs into planes, with the
 * per-plane mean inclination and semi-major axis carried on each plane so
 * the ring inherits the shell it occupies.
 *
 * The second level exists because the first is NOT sufficient: the Celestrak
 * `starlink` group spans several shells (43°/53°/70°/97.5° — verified live
 * 2026-08-05) whose RAAN ranges interleave densely. Within the 53° shell,
 * TLE-epoch scatter (nodal precession between updates) is ~±2.5° against a
 * 5° design spacing, so the sorted RAANs are quasi-continuous — max gap
 * 2.08° across 5061 sats — and a pure RAAN gap-split merges all four shells
 * into one plane with a mean inclination that matches none of them.
 * Inclination, which the shells keep 10-27° apart, is a hard separator;
 * `groupConstellation` splits on it first, then `groupIntoPlanes` recovers
 * the per-shell planes (exact for the well-separated OneWeb/GPS/Galileo/
 * Iridium designs, and for Starlink's 70°/97.5° shells; the dense 43°/53°
 * shells honestly collapse to one plane each — their design slots are not
 * recoverable from TLE epochs).
 */

import { EARTH_R_KM, GM_EARTH, orbitRegime } from '../orbit-engine/astro.js';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/**
 * Semi-major axis in km from mean motion in rad/min — Kepler's third law,
 * `n²a³ = GM` with n converted to rad/s. Exact for any eccentricity.
 */
export function smaKmFromMeanMotion(noRadPerMin) {
    const n = noRadPerMin / 60;
    return Math.cbrt(GM_EARTH / (n * n));
}

/** Altitude above the mean-Earth sphere, km. */
export function altKmFromSma(smaKm) {
    return smaKm - EARTH_R_KM;
}

/**
 * Orbit-plane elements from the three values a TLE gives directly. `shell`
 * reuses orbitRegime() so a plane's ring lines up with what the dossier
 * calls each member satellite's regime.
 */
export function planeElements({ raanRad, inclRad, noRadPerMin }) {
    const smaKm = smaKmFromMeanMotion(noRadPerMin);
    const altKm = altKmFromSma(smaKm);
    return {
        raanDeg: raanRad * DEG,
        inclDeg: inclRad * DEG,
        smaKm,
        altKm,
        shell: orbitRegime(altKm),
    };
}

/**
 * Wrap-aware mean of angles in degrees (so [358, 2] means ~0°, not 180°).
 * Normalised to [0, 360) — a mean near 240° must read 240, not -120.
 */
export function circularMeanDeg(anglesDeg) {
    let s = 0, c = 0;
    for (const a of anglesDeg) {
        s += Math.sin(a * RAD);
        c += Math.cos(a * RAD);
    }
    let m = Math.atan2(s, c) * DEG;
    if (m < 0) m += 360;
    // Float residue at the wrap: [358, 2] sums to ±1e-16, and a mean of
    // 359.9999999999999 is the same angle as 0. Collapse it so labels read
    // 0° and the sort order is stable.
    if (m >= 360 - 1e-6) m = 0;
    return m;
}

function closePlane(entries, idxs) {
    const raans = idxs.map(i => entries[i].raanDeg);
    const incls = idxs.map(i => entries[i].inclDeg);
    const smas  = idxs.map(i => entries[i].smaKm);
    const raanDeg = circularMeanDeg(raans);
    const inclDeg = incls.reduce((s, v) => s + v, 0) / incls.length;
    const smaKm   = smas.reduce((s, v) => s + v, 0) / smas.length;
    const altKm   = altKmFromSma(smaKm);
    return {
        raanDeg, inclDeg, smaKm, altKm,
        shell: orbitRegime(altKm),
        count: idxs.length,
        members: idxs,
    };
}

/**
 * Group constellation members into orbital planes by RAAN.
 *
 * Single-linkage clustering on circular RAAN: sort members around the
 * circle, cut wherever the gap between neighbours exceeds `raanTolDeg`.
 * The cut point is anchored at the *largest* gap first, so a plane whose
 * members straddle 0°/360° (real constellations do — plane spacing rarely
 * divides 360 evenly) stays one plane instead of wrapping into two.
 *
 * Within one Celestrak group, inclination and SMA vary by fractions of a
 * degree/km, so a RAAN-only split cannot misgroup; the per-plane means of
 * all three elements are returned for the ring. A singleton is a valid
 * plane (a GPS spare on its own RAAN still occupies a ring).
 *
 * @param {Array<{raanDeg:number, inclDeg:number, smaKm:number}>} entries
 * @param {{raanTolDeg?:number}} [opts] gap threshold; a gap strictly
 *        greater than the tolerance splits, equal does not
 * @returns {Array<{raanDeg, inclDeg, smaKm, altKm, shell, count, members}>}
 *          sorted by raanDeg; `members` are indices into `entries`
 */
export function groupIntoPlanes(entries, { raanTolDeg = 5 } = {}) {
    if (entries.length === 0) return [];

    const byRaan = entries
        .map((e, i) => ({ e, i }))
        .sort((a, b) => a.e.raanDeg - b.e.raanDeg);
    const n = byRaan.length;

    let cut = 0, largest = -1;
    for (let i = 0; i < n; i++) {
        const gap = (byRaan[(i + 1) % n].e.raanDeg - byRaan[i].e.raanDeg + 360) % 360;
        if (gap > largest) { largest = gap; cut = (i + 1) % n; }
    }

    const planes = [];
    let members = [byRaan[cut].i];
    for (let k = 1; k < n; k++) {
        const prev = byRaan[(cut + k - 1) % n].e;
        const curr = byRaan[(cut + k) % n].e;
        if ((curr.raanDeg - prev.raanDeg + 360) % 360 > raanTolDeg) {
            planes.push(closePlane(entries, members));
            members = [];
        }
        members.push(byRaan[(cut + k) % n].i);
    }
    planes.push(closePlane(entries, members));

    return planes.sort((a, b) => a.raanDeg - b.raanDeg);
}

/**
 * Two-level constellation grouping: split members into shells by
 * inclination (single-linkage gap-split, anchored at the sorted sequence
 * like `groupIntoPlanes`), then cluster each shell's RAANs into planes with
 * `groupIntoPlanes`. See the file header for why inclination must come
 * first. `members` on every returned plane are indices into the ORIGINAL
 * `entries` array (remapped from the band-local ones groupIntoPlanes
 * returns).
 *
 * @param {Array<{raanDeg:number, inclDeg:number, smaKm:number}>} entries
 * @param {{inclTolDeg?:number, raanTolDeg?:number}} [opts]
 * @returns same shape as groupIntoPlanes
 */
export function groupConstellation(entries, { inclTolDeg = 1.0, raanTolDeg = 5 } = {}) {
    if (entries.length === 0) return [];

    const byIncl = entries
        .map((e, i) => ({ e, i }))
        .sort((a, b) => a.e.inclDeg - b.e.inclDeg);

    const bands = [];
    let cur = [byIncl[0]];
    for (let i = 1; i < byIncl.length; i++) {
        if (byIncl[i].e.inclDeg - byIncl[i - 1].e.inclDeg > inclTolDeg) {
            bands.push(cur);
            cur = [];
        }
        cur.push(byIncl[i]);
    }
    bands.push(cur);

    const planes = [];
    for (const band of bands) {
        const bandPlanes = groupIntoPlanes(band.map(m => m.e), { raanTolDeg });
        for (const p of bandPlanes) {
            p.members = p.members.map(k => band[k].i);
            planes.push(p);
        }
    }
    return planes.sort((a, b) => a.raanDeg - b.raanDeg);
}

/**
 * The orbital plane as a closed ring of {lat, lon} in degrees on the sphere
 * of radius `radiusKm` (the plane's semi-major axis — the ring is drawn
 * where the satellites actually are, not on the surface).
 *
 * `segments + 1` points so the ring is closed. The caller maps the result
 * into its own entity layer (`Cesium.Cartesian3.fromDegrees`) — this module
 * does not know what Cesium is.
 */
export function planeRingDeg({ raanDeg, inclDeg, radiusKm }, segments = 180) {
    const raan = raanDeg * RAD, incl = inclDeg * RAD;
    const cO = Math.cos(raan), sO = Math.sin(raan);
    const ci = Math.cos(incl), si = Math.sin(incl);
    const pts = [];
    for (let i = 0; i <= segments; i++) {
        const u = (i / segments) * 2 * Math.PI;
        const x = radiusKm * Math.cos(u);
        const y = radiusKm * Math.sin(u);
        const X = x * cO - y * ci * sO;   // Rz(RAAN)·Rx(incl)·v
        const Y = x * sO + y * ci * cO;
        const Z = y * si;
        pts.push({
            lat: Math.asin(Math.min(1, Math.max(-1, Z / radiusKm))) * DEG,
            lon: Math.atan2(Y, X) * DEG,
        });
    }
    return pts;
}
