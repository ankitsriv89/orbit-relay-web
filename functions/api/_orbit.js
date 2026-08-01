// Shared constants for the orbit Pages Functions.
//
// The leading underscore keeps this out of Pages' file-based routing — it is a
// module, not an endpoint.
//
// The citation is a CONDITION of USSPACECOM's blanket approval to redistribute
// basic SSA data (TLE/OMM, SATCAT, decay), not a courtesy. It therefore ships
// on every response carrying Space-Track-derived data, and the orbit page
// renders it in the DOM.
//
// This string is duplicated in workers/orbit-ingest/src/derive.js because Pages
// Functions and the ingest Worker are separate bundles with no shared module
// root. workers/orbit-ingest/test/derive.test.mjs asserts the two are
// byte-identical — a silent divergence here is a licence problem, so it is
// tested rather than trusted.

export const CITATION =
  'Data source: Space-Track.org (USSPACECOM / 18th Space Defense Squadron). ' +
  'Redistributed under USSPACECOM express blanket approval for basic SSA data.';

export const CITATION_HEADER = 'X-Data-Source';
