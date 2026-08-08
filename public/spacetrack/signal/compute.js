/**
 * Signal-analysis arithmetic — no satellite.js, no Cesium, no DOM.
 *
 * Plan 34 wave 2.2. The maths trapped inside signal.js's addEventListener
 * callbacks, extracted so it can be unit-tested in Node against closed-form
 * geometry — the same discipline conjunction.js established for the screener.
 *
 * The one thing that cannot live here is a propagator: `computeElevation` needs
 * the satellite.js global. Callers hand the elevation sampler in as
 * `elevationAt(date, latDeg, lonDeg)` returning elevation in degrees (or null
 * when the propagator diverged — decayed objects do this, and it is a real
 * state rather than an error), exactly as conjunction.js takes its `sample` by
 * injection. The state machines below never touch a propagator directly.
 *
 * One deliberate behavioural fix over the inline originals: the visibility
 * window machine previously shipped every window with `maxElev: 0` because the
 * running maximum lived on the *closed* window's entry, which was pushed before
 * the next sample could update it. It is now tracked in a local like the pass
 * machine already did, so `maxElev` is the true peak.
 */

import { EARTH_R_KM } from '../../orbit-engine/astro.js';

export function degToRad(d) { return d * Math.PI / 180; }

/**
 * ECI → ECF about the z axis at GMST. The station frame is Earth-fixed, so the
 * sight-line computation must undo the rotation that the inertial propagation
 * carries with it.
 */
export function eciToEcf(pos, gmst) {
    const x = pos.x * Math.cos(gmst) + pos.y * Math.sin(gmst);
    const y = -pos.x * Math.sin(gmst) + pos.y * Math.cos(gmst);
    return { x, y, z: pos.z };
}

/**
 * Ground footprint of a satellite's visibility cone at an elevation mask,
 * expressed as a central angle in degrees.
 *
 * Central angle of the horizon circle at elevation ε:
 *   α = acos(R/(R+h) · cos ε) − ε
 * (the two cosines side by side are the "mask lifts the horizon" correction).
 */
export function coverageRadiusDeg(altKm, minElevDeg) {
    const radiusRad = Math.acos(EARTH_R_KM / (EARTH_R_KM + altKm) * Math.cos(degToRad(minElevDeg))) - degToRad(minElevDeg);
    return radiusRad * 180 / Math.PI;
}

/**
 * The coverage circle as a closed ring of {lat, lon} in degrees, using the
 * great-circle "destination from bearing and distance" identity.
 *
 * `segments + 1` points so the ring is closed. The caller maps the result into
 * its own entity layer (`Cesium.Cartesian3.fromDegrees`) — this module does not
 * know what Cesium is.
 */
export function coverageCircleDeg(satLatDeg, satLonDeg, radiusDeg, segments = 64) {
    const satLat = degToRad(satLatDeg);
    const satLon = degToRad(satLonDeg);
    const radiusRad = degToRad(radiusDeg);
    const pts = [];
    for (let i = 0; i <= segments; i++) {
        const bearing = (i / segments) * 2 * Math.PI;
        const lat = Math.asin(Math.sin(satLat) * Math.cos(radiusRad) +
                              Math.cos(satLat) * Math.sin(radiusRad) * Math.cos(bearing));
        const lon = satLon + Math.atan2(Math.sin(bearing) * Math.sin(radiusRad) * Math.cos(satLat),
                                        Math.cos(radiusRad) - Math.sin(satLat) * Math.sin(lat));
        pts.push({ lat: lat * 180 / Math.PI, lon: lon * 180 / Math.PI });
    }
    return pts;
}

/**
 * Ground-station visibility windows over a look-ahead span.
 *
 * Marches the span at `stepSec`; a window opens when the sampled elevation first
 * clears the mask and closes on the sample that drops below it. `elevationAt`
 * returning null (no solution) is skipped, exactly as a decayed object is.
 *
 * @returns {Array<{start: Date, end: Date, maxElev: number}>}
 */
export function visibilityWindows({ t0Ms, windowSec, stepSec, elevMask, stationLat, stationLon, elevationAt }) {
    const steps = Math.ceil(windowSec / stepSec);
    const windows = [];
    let inWindow = false;
    let windowStart = null;
    let windowMaxElev = 0;

    for (let i = 0; i <= steps; i++) {
        const date = new Date(t0Ms + i * stepSec * 1000);
        const elev = elevationAt(date, stationLat, stationLon);
        if (elev == null) continue;

        const above = elev >= elevMask;
        if (above && !inWindow) {
            inWindow = true;
            windowStart = date;
            windowMaxElev = elev;
        } else if (!above && inWindow) {
            inWindow = false;
            windows.push({ start: windowStart, end: date, maxElev: windowMaxElev });
        }
        if (above && inWindow && elev > windowMaxElev) windowMaxElev = elev;
    }
    if (inWindow) {
        windows.push({ start: windowStart, end: new Date(t0Ms + steps * stepSec * 1000), maxElev: windowMaxElev });
    }
    return windows;
}

/**
 * Pass predictions for a ground target: visibility windows long enough to be
 * useful. Same march as `visibilityWindows`, but a pass shorter than `minDurSec`
 * is dropped rather than reported.
 *
 * @returns {Array<{start: Date, end: Date, durSec: number, maxElev: number}>}
 */
export function predictPasses({ t0Ms, daysAhead, stepSec, elevMask, minDurSec, targetLat, targetLon, elevationAt }) {
    const totalMs = daysAhead * 86400000;
    const steps = Math.ceil(totalMs / (stepSec * 1000));
    const passes = [];
    let inPass = false;
    let passStart = null;
    let passMaxElev = 0;

    for (let i = 0; i <= steps; i++) {
        const date = new Date(t0Ms + i * stepSec * 1000);
        const elev = elevationAt(date, targetLat, targetLon);
        if (elev == null) continue;

        if (elev >= elevMask && !inPass) {
            inPass = true;
            passStart = date;
            passMaxElev = elev;
        } else if (elev < elevMask && inPass) {
            inPass = false;
            const durSec = (date - passStart) / 1000;
            if (durSec >= minDurSec) {
                passes.push({ start: passStart, end: date, durSec, maxElev: passMaxElev });
            }
        }
        if (inPass && elev > passMaxElev) passMaxElev = elev;
    }
    return passes;
}

/* ── RF / link budget ────────────────────────────────────────────────────────
 *
 * All of these are plain radio arithmetic in dB. `rangeKm` here is the slant
 * range the caller has available; signal.js feeds it the satellite altitude
 * directly, which is the conservative (near-zenith) case.
 */

export function eirpDbm(txPowerW, txGainDbi) {
    return 10 * Math.log10(txPowerW * 1000) + txGainDbi;
}

/* ── Geodetic → ECF and slant range (plan 34 §3.4) ─────────────────────────
 *
 * The ground-station link needs the station's Earth-fixed position and the
 * slant range to the satellite. satellite.js has both (geodeticToEcf and the
 * `rangeSat` of ecfToLookAngles), but this module deliberately carries no
 * satellite.js — the vendored copy is a browser global, and the whole point
 * of compute.js is Node-testability. The transform here is WGS-84 geodetic →
 * ECF, written out in metres (the engine and Cesium work in metres;
 * satellite.js works in km), with the SAME constants as the vendored
 * satellite.js (a = 6378.137, b = 6356.7523142 — the trimmed vendor rounds the
 * official 6356.752314245), so `slantRangeKm` agrees with its
 * ecfToLookAngles().rangeSat to floating-point precision — asserted in
 * signal-compute.test.mjs by loading the vendored file into a vm context.
 */

export const WGS84_A_KM = 6378.137;
export const WGS84_B_KM = 6356.7523142;

/**
 * WGS-84 geodetic → Earth-fixed position, metres.
 *
 * @param {{latDeg:number, lonDeg:number, altKm?:number}} g geodetic coordinates
 * @returns {{x:number, y:number, z:number}} ECF position in metres
 */
export function stationEcfMetres({ latDeg, lonDeg, altKm = 0 }) {
    const lat = degToRad(latDeg);
    const lon = degToRad(lonDeg);
    const e2 = (WGS84_A_KM * WGS84_A_KM - WGS84_B_KM * WGS84_B_KM) / (WGS84_A_KM * WGS84_A_KM);
    const chi = Math.sqrt(1 - e2 * Math.sin(lat) * Math.sin(lat));
    const h = altKm * 1000;
    const r = WGS84_A_KM * 1000 / chi + h;
    return {
        x: r * Math.cos(lat) * Math.cos(lon),
        y: r * Math.cos(lat) * Math.sin(lon),
        z: (WGS84_A_KM * 1000 * (1 - e2) / chi + h) * Math.sin(lat),
    };
}

/** Straight-line distance between an ECF station position and an ECF
 *  satellite position, km. Pure, so the RF tab can use a REAL slant range
 *  (station↔sat at this instant) instead of the near-zenith altitude bound. */
export function slantRangeKm(stationEcf, satEcf) {
    return Math.hypot(satEcf.x - stationEcf.x,
                      satEcf.y - stationEcf.y,
                      satEcf.z - stationEcf.z) / 1000;
}

/** Free-space path loss in dB — negative, as dB works. */
export function freeSpaceLossDb(rangeKm, freqMHz) {
    return -(20 * Math.log10(rangeKm * 1000) + 20 * Math.log10(freqMHz * 1e6) + 20 * Math.log10(4 * Math.PI / 299792458));
}

export function receivedPowerDbm(eirp, pathLossDb, rxGainDbi) {
    return eirp + pathLossDb + rxGainDbi;
}

export function thermalNoiseDbm(dataRateKbps) {
    return -174 + 10 * Math.log10(dataRateKbps * 1000);
}

export function snrDb(receivedPowerDbm, noiseDbm) {
    return receivedPowerDbm - noiseDbm;
}

/** System figure of merit G/T in dB/K, receiver noise temperature 290 K. */
export function systemGtoTDb(rxGainDbi) {
    return rxGainDbi - 10 * Math.log10(290);
}

export function linkMarginDb(snr, requiredSnrDb) {
    return snr - requiredSnrDb;
}

/** Everything the RF tab displays, in one call the handler can render. */
export function linkBudget({ freqMHz, txPowerW, txGainDbi, rxGainDbi, dataRateKbps, rangeKm, requiredSnrDb = 10 }) {
    const eirp = eirpDbm(txPowerW, txGainDbi);
    const pathLoss = freeSpaceLossDb(rangeKm, freqMHz);
    const receivedPower = receivedPowerDbm(eirp, pathLoss, rxGainDbi);
    const noise = thermalNoiseDbm(dataRateKbps);
    const snr = snrDb(receivedPower, noise);
    return { eirp, pathLoss, receivedPower, noise, snr, gToT: systemGtoTDb(rxGainDbi), margin: linkMarginDb(snr, requiredSnrDb) };
}
