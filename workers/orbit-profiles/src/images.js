/**
 * Image ingest — public-domain imagery to R2 with provenance.
 *
 * Imagery is NASA / USGS / NOAA only, public domain under 17 U.S.C. §105. The
 * allowlist id is `nasa-imagery` (not "NASA") because the NASA logo/insignia are
 * protected separately. assertAllowed() runs BEFORE any fetch, so a commercial
 * source costs zero network.
 *
 * Failure is a normal outcome — most of the catalogue has no image. Every
 * failure path (disallowed source, fetch failure, non-image type, undecodable
 * body, missing credit) returns null and writes nothing. Task 9 renders a typed
 * placeholder on the miss; this module only has to not write a bogus row.
 *
 * ## No image dependency — and none is needed
 *
 * `workers/orbit-profiles` stays dependency-free like its sibling. Rather than a
 * WebP encoder, the pipeline fetches an already-sized rendition from the source
 * (NASA's asset API offers `~thumb` / `~medium` / `~orig` and honours a `.webp`
 * suffix) and this module stores the bytes verbatim. The R2 key extension is
 * taken from the response content-type — `profiles/<norad>/primary.<ext>` rather
 * than a hardcoded `.webp`, a deliberate one-word widening of the Interface
 * Summary's key shape so the stored bytes and the key never disagree.
 *
 * Dimensions are read from the file header (WebP/PNG/JPEG/GIF), which is enough
 * to reject a body that is not actually an image and to populate width/height.
 */
import { assertAllowed } from './sources.js';

const EXT_BY_TYPE = {
  'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg',
  'image/jpg': 'jpg', 'image/gif': 'gif',
};

/** @returns {{width:number,height:number}|null} — null when `buf` is not a known image. */
export function imageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return webpDims(b) || pngDims(b) || jpegDims(b) || gifDims(b) || null;
}

function webpDims(b) {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = b.toString('ascii', 12, 16);
  if (fourcc === 'VP8 ') {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
             height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1 };
  }
  return null;
}

function pngDims(b) {
  if (b.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gifDims(b) {
  if (b.toString('ascii', 0, 3) !== 'GIF') return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpegDims(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i < b.length - 8) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

async function fetchImage(fetchFn, url) {
  try {
    const resp = await fetchFn(url);
    if (!resp || !resp.ok) return null;
    const type = String((resp.headers.get('content-type') || '')).split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) return null;
    const bytes = Buffer.from(await resp.arrayBuffer());
    const dims = imageDimensions(bytes);
    if (!dims) return null;
    return { bytes, ext, type, ...dims };
  } catch (_err) {
    return null;
  }
}

/**
 * @param {object} env  { ORBIT_R2, fetch? }
 * @param {number} norad
 * @param {{url:string, thumbUrl?:string, credit:string, license:string, source_id:string}} opts
 * @returns {Promise<{r2_key:string, thumb_key:string, width:number, height:number,
 *                    credit:string, license:string, source_url:string}|null>}
 *   null when the fetch fails, the body is not an image, the source is not
 *   allowlisted, or there is no credit — never throws.
 */
export async function ingestImage(env, norad, opts) {
  if (!isAllowedImageSource(opts.source_id)) return null;      // BEFORE any fetch
  if (!opts.credit || !String(opts.credit).trim()) return null; // unattributable ⇒ undisplayable

  const fetchFn = env.fetch || globalThis.fetch;
  const primary = await fetchImage(fetchFn, opts.url);
  if (!primary) return null;

  const thumb = opts.thumbUrl ? await fetchImage(fetchFn, opts.thumbUrl) : primary;
  const r2_key = `profiles/${norad}/primary.${primary.ext}`;
  const thumb_key = `profiles/${norad}/thumb.${(thumb || primary).ext}`;

  await env.ORBIT_R2.put(r2_key, primary.bytes, {
    httpMetadata: { contentType: primary.type },
    customMetadata: { credit: String(opts.credit), license: String(opts.license || '') },
  });
  await env.ORBIT_R2.put(thumb_key, (thumb || primary).bytes, {
    httpMetadata: { contentType: (thumb || primary).type },
    customMetadata: { credit: String(opts.credit), license: String(opts.license || '') },
  });

  return {
    r2_key, thumb_key,
    width: primary.width, height: primary.height,
    credit: String(opts.credit), license: String(opts.license || ''),
    source_url: opts.url,
  };
}

/** Distinct from assertAllowed(): images are additionally restricted to nasa-imagery. */
function isAllowedImageSource(sourceId) {
  try { assertAllowed(sourceId); } catch (_) { return false; }
  return sourceId === 'nasa-imagery';
}
