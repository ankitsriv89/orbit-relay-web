/**
 * Operator inference — Tier C in plan 33.
 *
 * **Space-Track has no operator field.** `COUNTRY_CODE` is the *registering
 * state*, not the operator, so every Starlink sits in the same "US" bucket as
 * every NOAA weather satellite and every NRO payload. Constellation views are
 * the single most useful way to read the catalog, so we infer the operator from
 * `OBJECT_NAME`.
 *
 * **This table is our inference, not authoritative data.** It drifts as new
 * constellations launch and renames happen, so:
 *   - the UI must label operator filters as derived, not sourced;
 *   - `operator` is NULL for anything unmatched, never guessed;
 *   - a wrong match is worse than no match, hence the anchored patterns below.
 *
 * Matching is first-hit in array order, so the specific entries come before the
 * general ones (SPACEBEE before nothing, GSAT0 before a hypothetical GSAT).
 * Costs zero API calls — it runs over rows we already hold.
 */

/**
 * Each entry: [id, label, RegExp anchored at the start of the name].
 *
 * Anchoring matters. An unanchored /IRIDIUM/ would also claim every piece of
 * "IRIDIUM 33 DEB", which is right, but an unanchored /SES/ would claim
 * "PLEIADES" — so patterns are start-anchored and word-boundaried where a
 * prefix is ambiguous.
 */
export const OPERATORS = [
  // ── LEO broadband constellations (the bulk of the modern catalog) ────────
  ['starlink',    'SpaceX (Starlink)',        /^STARLINK\b/],
  ['oneweb',      'Eutelsat OneWeb',          /^ONEWEB\b/],
  ['qianfan',     'Spacesail (Qianfan)',      /^(QIANFAN|CHUTIAN)\b/],
  ['guowang',     'China SatNet (Guowang)',   /^(GUOWANG|SATNET|HULIANWANG)\b/],
  ['kuiper',      'Amazon (Kuiper)',          /^(KUIPER|KA-0\d)\b/],

  // ── LEO comms / IoT ─────────────────────────────────────────────────────
  ['iridium',     'Iridium',                  /^IRIDIUM\b/],
  ['globalstar',  'Globalstar',               /^GLOBALSTAR\b/],
  ['orbcomm',     'Orbcomm',                  /^ORBCOMM\b/],
  ['swarm',       'Swarm (SpaceBEE)',         /^SPACEBEE\b/],
  ['ast',         'AST SpaceMobile',          /^(BLUEWALKER|BLUEBIRD)\b/],

  // ── Earth observation ───────────────────────────────────────────────────
  ['planet',      'Planet Labs',              /^(FLOCK|SKYSAT|DOVE|PELICAN)\b/],
  ['spire',       'Spire Global',             /^LEMUR\b/],
  ['iceye',       'ICEYE',                    /^ICEYE\b/],
  ['capella',     'Capella Space',            /^CAPELLA\b/],
  ['maxar',       'Maxar',                    /^(WORLDVIEW|GEOEYE|LEGION)\b/],
  ['copernicus',  'ESA (Copernicus)',         /^SENTINEL\b/],
  ['landsat',     'NASA/USGS (Landsat)',      /^LANDSAT\b/],
  ['yaogan',      'China (Yaogan)',           /^YAOGAN\b/],

  // ── Navigation ──────────────────────────────────────────────────────────
  // GLONASS is deliberately absent: its payloads are named COSMOS nnnn, which
  // is indistinguishable by name from hundreds of unrelated Russian objects.
  // See derive.js — that constellation is identified by its orbit signature.
  ['gps',         'US Space Force (GPS)',     /^NAVSTAR\b/],
  ['galileo',     'EU (Galileo)',             /^GSAT0/],
  ['beidou',      'China (BeiDou)',           /^BEIDOU\b/],
  ['irnss',       'ISRO (NavIC)',             /^(IRNSS|NVS-)/],
  ['qzss',        'Japan (QZSS)',             /^QZS-/],

  // ── GEO comms operators ─────────────────────────────────────────────────
  ['ses',         'SES',                      /^(SES-|ASTRA\b|O3B\b)/],
  ['intelsat',    'Intelsat',                 /^(INTELSAT|GALAXY)\b/],
  ['eutelsat',    'Eutelsat',                 /^(EUTELSAT|HOTBIRD)\b/],
  ['inmarsat',    'Inmarsat',                 /^INMARSAT\b/],
  ['viasat',      'Viasat',                   /^(VIASAT|WILDBLUE)\b/],
  ['echostar',    'EchoStar / DISH',          /^(ECHOSTAR|DIRECTV|SPACEWAY)\b/],

  // ── Civil agencies ──────────────────────────────────────────────────────
  ['noaa',        'NOAA',                     /^(NOAA|GOES|DMSP|SUOMI)\b/],
  ['eumetsat',    'EUMETSAT',                 /^(METOP|MSG-|METEOSAT)\b/],
  ['cma',         'China (Fengyun)',          /^FENGYUN\b/],
  ['roscosmos',   'Roscosmos (Meteor)',       /^METEOR\b/],
];

/**
 * @param {string|null|undefined} name  OBJECT_NAME as Space-Track spells it
 * @returns {string|null} operator id, or null when nothing matched
 *
 * Returns the id rather than the label so the stored value is stable when we
 * reword a label; the UI joins through OPERATOR_LABELS.
 */
export function operatorFor(name) {
  if (!name) return null;
  const n = String(name).toUpperCase().trim();
  for (const [id, , re] of OPERATORS) {
    if (re.test(n)) return id;
  }
  return null;
}

/** id → human label, for the HUD. */
export const OPERATOR_LABELS = Object.fromEntries(
  OPERATORS.map(([id, label]) => [id, label])
);
