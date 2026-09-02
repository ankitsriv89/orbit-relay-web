/**
 * The licence allowlist — an enforcement mechanism, not a policy note.
 *
 * Facts are not copyrightable (Feist v. Rural Telephone, 1991), but a selection
 * and arrangement of facts can be. So extracting atomic fields into our own
 * schema is sound; ingesting another site's curated structure is not. That line
 * is enforced here or nowhere: `assertAllowed()` runs on every fact before it is
 * written (facts.js), and a `source_id` absent from `SOURCES` aborts the write.
 *
 * The four entries and their licences are the spec's "Use — public domain or
 * CC-BY only" table (docs/superpowers/specs/2026-09-02-object-profiles-design.md).
 * Do not lengthen this list without reading the spec's exclusions:
 *
 *   - Gunter's Space Page — no stated licence (all rights reserved by default),
 *     one person's life's work. Hard exclude; "I only took the facts" is a
 *     defence we should not need to make.
 *   - ESA eoPortal (CC BY-SA 3.0 IGO), SatNOGS DB (CC BY-SA), Wikipedia
 *     (CC BY-SA) — share-alike would infect our own output. Excluded.
 *   - Commercial operator sites (Maxar, Planet, SpaceX) — all rights reserved;
 *     press-kit imagery is editorial-use licensed, which this database is not.
 *
 * SOURCES is a module constant, never a database read: the allowlist is a
 * property of the code that was reviewed, not of mutable data. A row deleted
 * from the `sources` table must not widen what ingest accepts.
 */

/**
 * @typedef {{id: string, name: string, url: string, license: string,
 *            attribution_text: string, priority: number}} Source
 */

/**
 * Priorities break field conflicts in facts.js — higher wins, ties by id
 * ascending for determinism. NSSDCA is the best descriptive source, GCAT the
 * best structured launch history, SATCAT the backbone, imagery lowest.
 *
 * @type {Record<string, Source>}
 */
export const SOURCES = {
  nssdca: {
    id: 'nssdca',
    name: 'NASA NSSDCA Master Catalog',
    url: 'https://nssdc.gsfc.nasa.gov/nmc/',
    license: 'public-domain',            // 17 U.S.C. §105 — U.S. government work
    attribution_text: 'NASA Space Science Data Coordinated Archive (NSSDCA)',
    priority: 100,
  },
  gcat: {
    id: 'gcat',
    name: "GCAT — Jonathan McDowell's General Catalog of Space Objects",
    url: 'https://planet4589.org/space/gcat/',
    license: 'CC-BY-4.0',                // attribution discharged by an <a> tag
    attribution_text: 'GCAT © Jonathan C. McDowell, planet4589.org (CC BY 4.0)',
    priority: 90,
  },
  'spacetrack-satcat': {
    id: 'spacetrack-satcat',
    name: 'Space-Track SATCAT',
    url: 'https://www.space-track.org/',
    license: 'spacetrack-blanket',       // already licensed; citation carried site-wide
    attribution_text: 'Space-Track.org (U.S. Space Force 18th Space Defense Squadron)',
    priority: 80,
  },
  'nasa-imagery': {
    id: 'nasa-imagery',
    name: 'NASA / USGS / NOAA imagery',
    url: 'https://images.nasa.gov/',
    license: 'public-domain',            // NASA logo/insignia protected separately — n/a here
    attribution_text: 'NASA / USGS / NOAA (public domain)',
    priority: 50,
  },
};

/** @returns {boolean} true iff `sourceId` is on the reviewed allowlist. */
export function isAllowed(sourceId) {
  return typeof sourceId === 'string' && Object.hasOwn(SOURCES, sourceId);
}

/**
 * The write-path gate. Callers that are writing use this form — the failure must
 * be loud and must abort the write, not log and continue.
 * @throws {Error} when `sourceId` is not in SOURCES
 */
export function assertAllowed(sourceId) {
  if (!isAllowed(sourceId)) {
    throw new Error(
      `refusing to write: source_id ${JSON.stringify(sourceId)} is not on the ` +
      `licence allowlist (${Object.keys(SOURCES).join(', ')}). ` +
      `A source must be licence-reviewed and added to src/sources.js before it can enter the database.`
    );
  }
}

const SEED_SQL = `
  INSERT INTO sources (id, name, url, license, attribution_text, priority, retrieved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    url = excluded.url,
    license = excluded.license,
    attribution_text = excluded.attribution_text,
    priority = excluded.priority,
    retrieved_at = excluded.retrieved_at
`;

/**
 * Upserts every SOURCES row into the `sources` table. Re-running is a no-op
 * rather than a duplicate-key error.
 * @returns {Promise<number>} number of entries upserted
 */
export async function seedSources(db) {
  const now = new Date().toISOString();
  const statements = Object.values(SOURCES).map((s) =>
    db.prepare(SEED_SQL).bind(s.id, s.name, s.url, s.license, s.attribution_text, s.priority, now)
  );
  await db.batch(statements);
  return statements.length;
}
