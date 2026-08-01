/**
 * Catalog overlay arithmetic — no Cesium, no DOM.
 *
 * Plan 34 wave 2.2. The density-heatmap binning/colour ramp and the object-age
 * colour ramp, lifted out of catalog.js's toggle handlers so they can be
 * unit-tested in Node (see workers/orbit-ingest/test/catalog-compute.test.mjs).
 *
 * The one impurity that used to live here is gone: `ageColor()` read
 * `Date.now()` inside the ramp, which made the ramp untestable. The ramp now
 * takes the reference time explicitly, so a test can pin it to a fixed instant.
 */

/**
 * Bin screen-space points into an integer grid.
 *
 * @param {Array<[number, number]>} coords points as [x, y] pixels
 * @param {number} binSize pixel size of a cell
 * @returns {{ bins: Array<{x: number, y: number, count: number}>, max: number }}
 *          `bins` in ascending first-seen order, `x`/`y` in cell units
 */
export function binHeatmap(coords, binSize) {
    const counts = new Map();
    for (const [x, y] of coords) {
        const bx = Math.floor(x / binSize);
        const by = Math.floor(y / binSize);
        const key = bx + ',' + by;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    let max = 0;
    for (const v of counts.values()) if (v > max) max = v;
    const bins = [];
    for (const [key, count] of counts) {
        const [x, y] = key.split(',').map(Number);
        bins.push({ x, y, count });
    }
    return { bins, max };
}

/**
 * The per-cell render style for a heatmap: a hot-colour ramp from cyan
 * (low density) through yellow to red, with radius and alpha scaling with
 * density. All the canvas drawing that consumes this lives in the page.
 *
 * @param {number} count hits in the cell
 * @param {number} max highest hit count across the map (the normaliser)
 * @param {number} binSize cell size in pixels
 * @returns {{ radius: number, alpha: number, r: number, g: number, b: number }}
 */
export function heatmapStyle(count, max, binSize) {
    const intensity = Math.min(count / max, 1);
    const radius = binSize * (1 + intensity * 3);
    const alpha = 0.05 + intensity * 0.35;
    const r = Math.round(intensity < 0.5 ? intensity * 2 * 255 : 255);
    const g = Math.round(intensity < 0.5 ? 200 + intensity * 110 : 255 * (1 - intensity));
    const b = Math.round(intensity < 0.5 ? 255 : 255 * (1 - intensity));
    return { radius, alpha, r, g, b };
}

/**
 * Object-age colour ramp. Fresh objects are bright cyan, three-year-old ones
 * have faded towards deep blue; the alpha also falls so aged catalogue rows
 * recede visually. `null` for a missing or unparseable date — the caller keeps
 * the object's normal colour rather than colouring it as ancient.
 *
 * @param {string} dateStr `EPOCH` or `LAUNCH_DATE`
 * @param {number} nowMs reference time, explicit so the ramp is testable
 * @returns {{r: number, g: number, b: number, a: number}|null}
 */
export function ageRamp(dateStr, nowMs) {
    if (!dateStr) return null;
    const ageDays = (nowMs - Date.parse(dateStr)) / 86400000;
    if (!Number.isFinite(ageDays)) return null;
    const maxAge = 365 * 3;
    const t = Math.min(ageDays / maxAge, 1);
    const r = Math.round(0 + t * 0);
    const g = Math.round(210 * (1 - t * 0.85));
    const b = Math.round(255 * (1 - t * 0.7));
    const a = 0.95 - t * 0.5;
    return { r, g, b, a };
}

/** `ageRamp` as a `rgba(...)` string, or null for a missing/unparseable date. */
export function ageColorCss(dateStr, nowMs) {
    const c = ageRamp(dateStr, nowMs);
    return c ? `rgba(${c.r},${c.g},${c.b},${c.a})` : null;
}
