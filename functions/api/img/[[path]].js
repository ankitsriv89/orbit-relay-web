// Cloudflare Pages Function — R2 passthrough for profile imagery.
//
//   GET /api/img/25544/primary.webp
//   GET /api/img/25544/thumb.webp
//
// images.js writes the bytes to `profiles/<norad>/primary.<ext>` (and thumb);
// this serves them. Egress from R2 is free, and Class B (read) is only reached
// on a cache miss — the long max-age below is what keeps that rare.
//
// The path is validated against the exact `profiles/<digits>/<name>.<ext>` shape
// rather than passed through: a Function that streams an arbitrary R2 key on
// request is a bucket-enumeration endpoint.

const KEY_RE = /^profiles\/\d+\/(primary|thumb)\.(webp|png|jpg|jpeg|gif)$/;

const TYPE_BY_EXT = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif',
};

export async function onRequest(context) {
  const { env, params } = context;

  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const key = `profiles/${segments.join('/')}`;
  if (!KEY_RE.test(key)) {
    return new Response('Not found', { status: 404 });
  }
  if (!env || !env.ORBIT_R2) {
    return new Response('Image storage is not configured on this deployment.', { status: 503 });
  }

  const object = await env.ORBIT_R2.get(key).catch(() => null);
  if (!object) return new Response('Not found', { status: 404 });

  const ext = key.slice(key.lastIndexOf('.') + 1);
  const body = object.body ?? (object.arrayBuffer ? await object.arrayBuffer() : null);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': TYPE_BY_EXT[ext] || 'application/octet-stream',
      // Images are immutable per key — a new image lands under a new NORAD or
      // replaces bytes at the same key on a re-run; a day is a safe floor and
      // stale-while-revalidate keeps a refresh off the visitor's critical path.
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
