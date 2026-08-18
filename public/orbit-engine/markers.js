/**
 * Per-type marker shapes for satellite billboards.
 *
 * Why shapes at all: at the sizes these objects render (3-5 screen px) a
 * satellite dot and a background star core are both small bright round marks,
 * and the eye cannot separate them. Shape does what size alone could not —
 * a star is always round, so anything angular reads as an object.
 *
 * Why billboards are affordable: measured on this repo's real Cesium build
 * across every globe route, a BillboardCollection renders within timer noise
 * of a PointPrimitiveCollection at 500 / 2,000 / 6,000 / 12,000 objects
 * (median frame delta within +-0.2ms, no trend as N grows). The cost that
 * WOULD matter is texture count, not object count, which is why this module
 * caches one canvas per (shape, colour, size) triple and hands the SAME image
 * to every billboard that shares it: Cesium packs those into one atlas and
 * draws the collection in a single batch. Generating a texture per object
 * would defeat that entirely.
 *
 * Pure except for `document` inside the draw functions — the shape table and
 * the type mapping are importable in Node, which is what markers.test.mjs
 * exercises.
 */

/** Canonical shapes. Chosen to stay distinguishable at ~8 device px, which
 *  rules out anything with interior detail. */
export const SHAPES = ['circle', 'square', 'diamond', 'triangle', 'cross'];

/**
 * Space-Track OBJECT_TYPE -> shape. The three real catalog values plus the
 * fallback; `UNKNOWN` and anything unrecognised stay round, so an object we
 * cannot classify never claims a meaning it does not have.
 *
 * PAYLOAD square, ROCKET BODY triangle (a nose-cone read), DEBRIS diamond
 * (small and angular, deliberately the least "solid" of the three).
 */
export const TYPE_SHAPE = {
    'PAYLOAD':      'square',
    'ROCKET BODY':  'triangle',
    'DEBRIS':       'diamond',
    'UNKNOWN':      'circle',
};

/**
 * Orbit shell -> shape, for views grouped by regime rather than by object
 * type (/constellations/). Same four regimes astro.js's orbitRegime returns.
 *
 * Deliberately NOT the same table as TYPE_SHAPE: a square means "payload" on
 * /spacetrack/ and "LEO" here, because the two pages group by different
 * things. Each page's legend says which, and no page shows both at once.
 *
 * Shape doubles the shell encoding that colour already carries — which is the
 * point: colour alone is lost to the far-side fade (a dimmed dot's hue is
 * hard to read) and to colourblind viewers, while shape survives both.
 */
export const SHELL_SHAPE = {
    LEO: 'square',
    MEO: 'diamond',
    GEO: 'triangle',
    HEO: 'cross',
};

/** Map an orbit shell (LEO/MEO/GEO/HEO) to a shape name. */
export function shapeForShell(shell) {
    if (!shell) return 'circle';
    return SHELL_SHAPE[String(shell).toUpperCase()] || 'circle';
}

/** Map a raw OBJECT_TYPE (any case, may be null) to a shape name. */
export function shapeForType(objectType) {
    if (!objectType) return 'circle';
    return TYPE_SHAPE[String(objectType).toUpperCase()] || 'circle';
}

/* One canvas per (shape, colour, size). Keyed by string; never evicted —
 * the key space is tiny (5 shapes x a handful of palette colours). */
const _cache = new Map();

/**
 * A marker texture: `size` device px, filled `css`, with the dark outline
 * that separates a satellite from a light source. Returns a canvas, which
 * Cesium accepts directly as a billboard `image`.
 *
 * The outline is the whole point — see the engine's addSatellite note. A
 * filled shape with no outline is still just a bright blob.
 */
export function markerCanvas(shape, css, size = 16) {
    const key = `${shape}|${css}|${size}`;
    const hit = _cache.get(key);
    if (hit) return hit;

    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const m = size * 0.18;          // margin, leaves room for the stroke
    const a = m, b = size - m, mid = size / 2;

    x.fillStyle = css;
    x.strokeStyle = 'rgba(0, 0, 0, 0.62)';
    x.lineWidth = Math.max(1.5, size * 0.11);
    x.lineJoin = 'round';
    x.beginPath();
    switch (shape) {
        case 'square':
            x.rect(a, a, b - a, b - a);
            break;
        case 'diamond':
            x.moveTo(mid, a); x.lineTo(b, mid); x.lineTo(mid, b); x.lineTo(a, mid);
            x.closePath();
            break;
        case 'triangle':
            x.moveTo(mid, a); x.lineTo(b, b); x.lineTo(a, b);
            x.closePath();
            break;
        case 'cross': {
            const w = size * 0.16;
            x.moveTo(mid - w, a); x.lineTo(mid + w, a); x.lineTo(mid + w, mid - w);
            x.lineTo(b, mid - w); x.lineTo(b, mid + w); x.lineTo(mid + w, mid + w);
            x.lineTo(mid + w, b); x.lineTo(mid - w, b); x.lineTo(mid - w, mid + w);
            x.lineTo(a, mid + w); x.lineTo(a, mid - w); x.lineTo(mid - w, mid - w);
            x.closePath();
            break;
        }
        default:                    // circle
            x.arc(mid, mid, (b - a) / 2, 0, 2 * Math.PI);
    }
    x.fill();
    x.stroke();

    _cache.set(key, c);
    return c;
}

/** Test seam: how many distinct textures have been generated. A rising count
 *  under a steady shape/colour set means the cache key is wrong. */
export function markerCacheSize() { return _cache.size; }
