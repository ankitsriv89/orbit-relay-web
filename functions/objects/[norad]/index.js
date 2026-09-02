// Cloudflare Pages Function — the crawlable shell for one object's page.
//
//   GET /objects/25544/
//
// Serves a static HTML shell with a server-injected <title>, meta description
// and JSON-LD; object.js then client-renders the visible content from
// /api/object/<norad>. Per the spec this is the only route to a crawlable
// per-object page that does not break the no-build-step rule.
//
// Hazards handled here:
//   - No insertAdjacentHTML with API-derived content. The object name comes
//     from an upstream catalogue: it is HTML-escaped for the text contexts it
//     lands in, and JSON.stringify handles the JSON-LD context (with a `<`
//     escape so a name containing "</script>" cannot break out).
//   - A missing NORAD renders a real 404, not a shell with an empty title.

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** JSON for a <script type="application/ld+json"> — `<` escaped so it cannot break out. */
const ldjson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

const CITATION = 'Data source: Space-Track.org (USSPACECOM / 18th Space Defense Squadron). ' +
  'Redistributed under USSPACECOM express blanket approval for basic SSA data.';

export async function onRequest(context) {
  const { env, params, request } = context;

  const raw = String(params.norad || '');
  if (!/^\d+$/.test(raw)) {
    return new Response(notFoundHtml('That is not a valid catalog number.'), {
      status: 404, headers: htmlHeaders(0),
    });
  }
  const norad = Number.parseInt(raw, 10);

  if (!env || !env.ORBIT_DB) {
    // No catalog binding — serve the shell anyway; object.js will show its own
    // error. A 503 here would hide an otherwise-usable page from a crawler.
    return new Response(shell(norad, null), { status: 200, headers: htmlHeaders(300) });
  }

  const row = await env.ORBIT_DB.prepare(
    'SELECT NORAD_CAT_ID, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, COUNTRY_CODE, LAUNCH_DATE, DECAY_DATE FROM objects WHERE NORAD_CAT_ID = ?'
  ).bind(norad).first().catch(() => null);

  if (!row) {
    return new Response(notFoundHtml(`No catalogued object with NORAD ${norad}.`), {
      status: 404, headers: htmlHeaders(0),
    });
  }

  let profile = null;
  if (env.PROFILE_DB) {
    profile = await env.PROFILE_DB.prepare(
      'SELECT official_name, mission_type, operator_name, owner_country, prose FROM profiles WHERE norad = ?'
    ).bind(norad).first().catch(() => null);
  }

  // The shell is the one path here that runs a Function per hit, so its
  // Cache-Control is what keeps repeat crawls at the edge. Profiles change on a
  // bulk-import cadence — an hour is safe and still same-day fresh.
  return new Response(shell(norad, row, profile), { status: 200, headers: htmlHeaders(3600) });
}

function htmlHeaders(maxAge) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Data-Source': CITATION,
    'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
  };
}

function displayName(row, profile) {
  return (profile && profile.official_name) || (row && row.OBJECT_NAME) || `NORAD ${row ? row.NORAD_CAT_ID : ''}`;
}

function metaDescription(row, profile) {
  if (profile && profile.prose) return profile.prose.slice(0, 300);
  if (!row) return 'One object from the Orbital Relay catalogue.';
  const bits = [row.OBJECT_TYPE, row.COUNTRY_CODE, row.OBJECT_ID].filter(Boolean).join(' · ');
  const launched = /^\d{4}-\d{2}-\d{2}$/.test(String(row.LAUNCH_DATE || '')) ? `, launched ${row.LAUNCH_DATE}` : '';
  return `Catalogue object ${row.NORAD_CAT_ID}${bits ? ` — ${bits}` : ''}${launched}. Mission, operator, bus and status where known, each fact sourced.`;
}

function shell(norad, row, profile) {
  const name = displayName(row, profile);
  const desc = metaDescription(row, profile);
  const canonical = `https://orbitalrelay.space/objects/${norad}/`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: `${name} — object ${norad}`,
    description: desc,
    url: canonical,
    isBasedOn: 'https://www.space-track.org/',
    ...(profile && profile.operator_name ? { creator: { '@type': 'Organization', name: profile.operator_name } } : {}),
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(name)} (object ${norad}) — Orbital Relay</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#050810">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(name)} — object ${norad}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="https://orbitalrelay.space/icons/og-cover.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/docs.css">
<link rel="stylesheet" href="/objects/objects.css">
<script type="application/ld+json">${ldjson(ld)}</script>
</head>
<body data-norad="${norad}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <div class="site-header__inner">
    <a class="wordmark" href="/" aria-label="Orbital Relay home">
      <img src="/icons/logo.png" alt="" width="28" height="28" class="wordmark__logo">
      ORBITAL<span class="wordmark__accent">·</span>RELAY
    </a>
    <a class="header-cta" href="/orbit/">LAUNCH →</a>
  </div>
</header>
<main id="main" class="docs-main obj-detail">
  <p class="obj-crumb"><a href="/objects/">← Encyclopedia</a></p>
  <h1 id="obj-title">${esc(name)}</h1>
  <p class="obj-detail__sub">Catalog number ${norad}<span id="obj-cospar"></span></p>
  <div id="obj-body" aria-live="polite"><p class="obj-loading">Loading the profile…</p></div>
  <p class="obj-provenance" id="obj-cite">Orbital data: Space-Track.org (USSPACECOM / 18th Space Defense Squadron).</p>
</main>
<footer class="site-footer"><div class="site-footer__inner"><div class="site-footer__bottom">
  <p class="site-footer__meta">© 2026 Orbital Relay · Descriptive facts: NASA NSSDCA / GCAT (CC BY 4.0) / Space-Track SATCAT · Orbital data: Space-Track.org (USSPACECOM / 18th Space Defense Squadron), redistributed under USSPACECOM express blanket approval for basic SSA data.</p>
</div></div></footer>
<script type="module" src="/objects/object.js"></script>
</body>
</html>`;
}

function notFoundHtml(message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Object not found — Orbital Relay</title>
<meta name="robots" content="noindex">
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/docs.css">
</head>
<body>
<header class="site-header"><div class="site-header__inner">
  <a class="wordmark" href="/" aria-label="Orbital Relay home">ORBITAL<span class="wordmark__accent">·</span>RELAY</a>
</div></header>
<main id="main" class="docs-main">
  <h1>Object not found</h1>
  <p>${esc(message)}</p>
  <p><a href="/objects/">← Back to the encyclopedia</a></p>
</main>
</body>
</html>`;
}
