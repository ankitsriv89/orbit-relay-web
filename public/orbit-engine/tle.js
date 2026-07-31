/**
 * TLE fetching and parsing — shared by /orbit/ and /spacetrack/ (plan 33 wave 3).
 */

const TLE_ENDPOINT  = '/api/tle';          // Pages Function: live proxy + edge cache
const TLE_FILE_BASE = '/orbit/data/tle';   // shipped baseline snapshots (Celestrak only)

/**
 * Parse a 3LE bundle: name line, line 1, line 2, repeating.
 *
 * l1/l2 are kept alongside the satrec because the propagation worker builds its
 * own satrecs from the raw lines, and inspector paths are requested by lines.
 */
export function parseTLE(text) {
    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const sats  = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i];
        const l1   = lines[i + 1];
        const l2   = lines[i + 2];
        if (l1.startsWith('1') && l2.startsWith('2')) {
            try { sats.push({ name, l1, l2, satrec: satellite.twoline2satrec(l1, l2) }); }
            catch (_) { /* skip malformed TLE */ }
        }
    }
    return sats;
}

/**
 * Chunked parse for large bundles (e.g. 8000 Starlink TLEs). Returns a promise
 * that resolves with the full array. The heavy `twoline2satrec` work is spread
 * across idle frames so the main thread stays responsive.
 */
export function parseTLEChunked(text, chunkSize = 500) {
    const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
    const raw = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i];
        const l1   = lines[i + 1];
        const l2   = lines[i + 2];
        if (l1.startsWith('1') && l2.startsWith('2')) raw.push({ name, l1, l2 });
    }
    return new Promise(resolve => {
        const sats = [];
        let idx = 0;
        function go() {
            const end = Math.min(idx + chunkSize, raw.length);
            for (let i = idx; i < end; i++) {
                const r = raw[i];
                try { sats.push({ ...r, satrec: satellite.twoline2satrec(r.l1, r.l2) }); }
                catch (_) { /* skip malformed TLE */ }
            }
            idx = end;
            if (idx < raw.length) {
                if (typeof requestIdleCallback === 'function') {
                    requestIdleCallback(go, { timeout: 50 });
                } else {
                    setTimeout(go, 0);
                }
            } else {
                resolve(sats);
            }
        }
        go();
    });
}

/** Upstream signals "no data" with prose and a 200, so the body has to be read. */
export function tleLooksValid(t) {
    return t && !t.includes('No GP data') && !t.includes('Invalid query') &&
           !t.startsWith('GP data has not updated') && t.trim().length >= 10;
}

/**
 * @param {string} group  group slug, e.g. STARLINK or iridium-NEXT
 * @param {object} [opts]
 * @param {string} [opts.source]  'celestrak' | 'spacetrack'
 * @param {boolean} [opts.live]   prefer the API over the shipped baseline
 * @returns {Promise<string>} the bundle text, or '' if nothing resolved
 */
export async function fetchTLE(group, { source = 'celestrak', live = false } = {}) {
    // Baseline filenames are always lowercase; the Celestrak group name is not
    // (`iridium-NEXT`). Lowercasing the slug here is what makes the two line up
    // — the file used to ship mixed-case, so Iridium silently 404'd its baseline
    // and always took the slow API path.
    const slug    = group.toLowerCase();
    const fileUrl = `${TLE_FILE_BASE}/${source}/${slug}.txt`;
    const apiUrl  = `${TLE_ENDPOINT}?source=${encodeURIComponent(source)}&group=${encodeURIComponent(group)}`;

    // Only Celestrak has shipped baseline files. Space-Track is served purely
    // from the R2 bundles the ingest builds — and deliberately so: a static
    // Space-Track file in the repo would be redistribution without the citation
    // the approval is conditioned on. So that source is API-only, and a 404
    // there means "not ingested yet" rather than "fall back to Celestrak".
    const order = source === 'celestrak'
        ? (live ? [apiUrl, fileUrl] : [fileUrl, apiUrl])
        : [apiUrl];

    for (const url of order) {
        try {
            const r = await fetch(url);
            if (!r.ok) continue;
            const t = await r.text();
            if (tleLooksValid(t)) return t;
        } catch (_) { /* try next */ }
    }
    return '';
}
