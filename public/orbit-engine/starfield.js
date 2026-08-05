/**
 * Procedural star skyBox (plan 34 §3.3 C4, spec #20 "HDR stars").
 *
 * The plan's skyBox bullet said "needs asset sourcing — keep it small given
 * the 3.2 MB lesson from §1.3". This module resolves the sourcing with zero
 * external assets: a deterministic 3D star field (seeded PRNG, positions on
 * the unit sphere) rendered onto six canvas faces, exported as PNG data URLs
 * and handed to Cesium's SkyBox. A few KB of generated image strings replaces
 * Cesium's built-in Tycho-2 starfield, which Cesium 1.113 would otherwise
 * fetch as six JPEGs from the Cesium CDN on every page.
 *
 * The module is pure: no Cesium, no DOM at import time (Node can import the
 * math — starfield.test.mjs does). The canvas/`document` parts live inside
 * functions that only run in a browser.
 *
 * Face convention: six right-handed frames with `t1 × t2 = n`, the same
 * orientation discipline Cesium's cube-map sampling expects. A direction is
 * projected onto the face whose normal has the largest |dot| — exactly one
 * face except on exact boundaries, where both neighbours see the same edge
 * coordinate, so stars never double-draw and seams stay continuous in
 * direction space. Keys match Cesium's SkyBox `sources` map
 * (positiveX/negativeX/…).
 */

const FACE_KEYS = [
    'positiveX', 'negativeX',
    'positiveY', 'negativeY',
    'positiveZ', 'negativeZ',
];
export { FACE_KEYS };

/** Six right-handed face frames (t1 × t2 === n), so the cube corners project
 *  to the same (u, v) ∈ {±1}² on every face that sees them. */
export const FACE_FRAMES = {
    positiveX: { n: [ 1,  0,  0], t1: [0,  1,  0], t2: [0, 0,  1] },
    negativeX: { n: [-1,  0,  0], t1: [0, -1,  0], t2: [0, 0,  1] },
    positiveY: { n: [ 0,  1,  0], t1: [0,  0,  1], t2: [1, 0,  0] },
    negativeY: { n: [ 0, -1,  0], t1: [0,  0, -1], t2: [1, 0,  0] },
    positiveZ: { n: [ 0,  0,  1], t1: [1,  0,  0], t2: [0, 1,  0] },
    negativeZ: { n: [ 0,  0, -1], t1: [-1, 0,  0], t2: [0, 1,  0] },
};

/**
 * Deterministic 32-bit PRNG (mulberry32). Two draws on the same seed are
 * identical everywhere — the sky is the same on every load and on every
 * platform, which is what makes it testable.
 */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Deterministic star field: `count` stars, each {x, y, z} on the unit sphere
 * (uniform direction), `b` brightness in [0.15, 1] (never zero — a fully
 * invisible star is wasted pixels), and `tint` a near-white {r, g, b} so the
 * sky gets the faint blue/warm variety a real night sky has without any
 * colour stepping away from the product's mono palette.
 */
export function generateStars(seed, count = 600) {
    const rng = mulberry32(seed);
    const TINTS = [
        { r: 1.00, g: 1.00, b: 1.00 },
        { r: 0.82, g: 0.89, b: 1.00 },
        { r: 1.00, g: 0.91, b: 0.78 },
        { r: 0.90, g: 0.96, b: 1.00 },
    ];
    const stars = [];
    for (let i = 0; i < count; i++) {
        const z = rng() * 2 - 1;
        const phi = rng() * 2 * Math.PI;
        const s = Math.sqrt(1 - z * z);
        stars.push({
            x: s * Math.cos(phi),
            y: s * Math.sin(phi),
            z,
            b: 0.15 + 0.85 * rng(),
            tint: TINTS[(rng() * TINTS.length) | 0],
        });
    }
    return stars;
}

const dot = (a, b) => a[0] * b.x + a[1] * b.y + a[2] * b.z;

/** The face key whose normal has the largest SIGNED dot with `d` — the
 *  cube-map face that owns this direction (the sign of the dominant axis
 *  component selects the + or − face; the component's magnitude selects the
 *  axis). Ties (exact boundaries) break to the first face in FACE_KEYS
 *  order. */
export function faceForDir(d) {
    let best = FACE_KEYS[0], bestDot = -Infinity;
    for (const key of FACE_KEYS) {
        const a = dot(FACE_FRAMES[key].n, d);
        if (a > bestDot) { bestDot = a; best = key; }
    }
    return best;
}

/**
 * Project direction `d` onto face `face`'s plane. Returns {u, v} in the
 * face's own coordinate space (each in [-1, 1] for directions the face
 * actually sees, i.e. where dot(d, n) > 0), or null for the back half of
 * the cube.
 */
export function projectToFace(d, face) {
    const f = FACE_FRAMES[face];
    const a = dot(f.n, d);
    if (a <= 0) return null;
    return { u: dot(f.t1, d) / a, v: dot(f.t2, d) / a };
}

/**
 * Draw one skyBox face onto `ctx` (a 2D context of a size×size canvas).
 * Only stars owned by this face (faceForDir) are drawn, so no star appears
 * twice and the field stays coherent across seams. Bright stars get a soft
 * radial glow behind the core; the rest are plain discs.
 */
export function drawSkyFace(ctx, size, stars, face) {
    ctx.clearRect(0, 0, size, size);
    const frame = FACE_FRAMES[face];
    const half = size / 2;

    // Two passes: glows first (they are translucent), cores on top.
    for (const s of stars) {
        if (faceForDir(s) !== face) continue;
        const uv = projectToFace(s, face);
        if (!uv) continue;
        const px = (uv.u + 1) * half;
        const py = (1 - uv.v) * half;
        if (s.b < 0.72) continue;
        const g = ctx.createRadialGradient(px, py, 0, px, py, 3 + s.b * 7);
        const t = s.tint;
        g.addColorStop(0, `rgba(${Math.round(255 * t.r)},${Math.round(255 * t.g)},${Math.round(255 * t.b)},${(0.30 * s.b).toFixed(3)})`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(px - 11, py - 11, 22, 22);
    }

    for (const s of stars) {
        if (faceForDir(s) !== face) continue;
        const uv = projectToFace(s, face);
        if (!uv) continue;
        const px = (uv.u + 1) * half;
        const py = (1 - uv.v) * half;
        const t = s.tint;
        const r = Math.max(0.4, 0.5 + s.b * s.b * 2.2);
        ctx.fillStyle = `rgba(${Math.round(255 * t.r)},${Math.round(255 * t.g)},${Math.round(255 * t.b)},${s.b.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, 2 * Math.PI);
        ctx.fill();
    }
}

/**
 * Build the six Cesium SkyBox sources (PNG data URLs) for the seeded
 * starfield. DOM-only: creates canvases, draws the faces, encodes. Returns
 * {positiveX, negativeX, positiveY, negativeY, positiveZ, negativeZ}.
 */
export function buildSkyFaceSources({ size = 512, seed = 20260806, starCount = 600 } = {}) {
    const stars = generateStars(seed, starCount);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const sources = {};
    for (const key of FACE_KEYS) {
        drawSkyFace(ctx, size, stars, key);
        sources[key] = canvas.toDataURL('image/png');
    }
    return sources;
}
