/**
 * Shared object dossier — inspector panel wired to a Cesium globe.
 *
 * Extracted from catalog.js and conjunctions.js, which had ~95 lines of this
 * verbatim (open/close/refreshLive, all 13 `setText('d-*')` calls). The two
 * pages had already diverged: catalog.js also drew a fading orbit trail and
 * pushed `State.selectedObject` on open so Signal could pick up the
 * selection; conjunctions.js did neither, even though it reads
 * `State.selectedObject` itself for its own query. That's a gap, not an
 * intentional omission, so both behaviours are unconditional here rather
 * than gated — every caller gets cross-page selection sync, and gets a
 * trail if it passes `trail: true`.
 */
import { orbVel, fmtLat, fmtLon } from '/orbit-engine/astro.js';
import { $, setText, relTime } from '/spacetrack/shared/utils.js';
import { getApiBase } from '/spacetrack/shared/api.js';

const TRAIL_MAX = 60;            // max positions in the trail
const TRAIL_STEP_MS = 2000;      // ms between trail samples

export function createDossier({ viewer, engine, State, trail = false } = {}) {
    const dossier = $('dossier');
    const dossierClose = $('dossier-close');
    let dossierVisuals = null;
    let dossierTimer = null;
    let dossierSatrec = null;

    let trailPositions = [];
    let trailEntity = null;
    let trailTimer = null;

    function updateTrail() {
        if (!dossierSatrec) return;
        const p = engine.geo(dossierSatrec);
        if (!p) return;
        trailPositions.push(Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt * 1000));
        if (trailPositions.length > TRAIL_MAX) trailPositions.shift();
        if (trailPositions.length < 2) return;

        if (trailEntity) viewer.entities.remove(trailEntity);
        trailEntity = viewer.entities.add({
            polyline: {
                positions: trailPositions,
                width: 1.5,
                material: new Cesium.PolylineGlowMaterialProperty({
                    glowPower: 0.2,
                    color: Cesium.Color.CYAN.withAlpha(0.35),
                }),
                arcType: Cesium.ArcType.NONE,
            },
        });
        engine.requestRender();
    }

    function startTrail() {
        if (!trail) return;
        trailPositions = [];
        if (trailTimer) clearInterval(trailTimer);
        trailTimer = engine.own(setInterval(updateTrail, TRAIL_STEP_MS));
        updateTrail();
    }

    function stopTrail() {
        if (!trail) return;
        if (trailTimer) { clearInterval(trailTimer); trailTimer = null; }
        if (trailEntity) { viewer.entities.remove(trailEntity); trailEntity = null; }
        trailPositions = [];
    }

    function close() {
        engine.removeEntities(dossierVisuals);
        dossierVisuals = null;
        dossierSatrec = null;
        stopTrail();
        if (dossierTimer) { clearInterval(dossierTimer); dossierTimer = null; }
        if (dossier) dossier.hidden = true;
    }
    dossierClose?.addEventListener('click', close);

    function refreshLive() {
        if (!dossierSatrec) return;
        const p = engine.geo(dossierSatrec);
        if (!p) { setText('d-lat', 'no solution'); return; }
        setText('d-lat', fmtLat(p.lat));
        setText('d-lon', fmtLon(p.lon));
        setText('d-alt', `${Math.round(p.alt)} km`);
        setText('d-vel', `${orbVel(p.alt).toFixed(2)} km/s`);
    }

    async function open(norad, meta) {
        if (!dossier || norad == null) return;
        dossier.hidden = false;
        setText('dossier-status', 'loading…');

        if (meta?.satrec) {
            State.set('selectedObject', {
                norad: meta.norad,
                name: meta.name,
                type: meta.group,
                regime: meta.row?.regime || '',
                l1: meta.l1,
                l2: meta.l2,
            });
            dossierSatrec = meta.satrec;
            engine.removeEntities(dossierVisuals);
            dossierVisuals = engine.addInspectVisuals(meta, '#ffffff');
            setText('dossier-name', `// ${meta.name}`);
            refreshLive();
            if (dossierTimer) clearInterval(dossierTimer);
            dossierTimer = engine.own(setInterval(refreshLive, 1000));
            startTrail();
        }

        let data;
        try {
            const r = await fetch(`${getApiBase()}/object/${encodeURIComponent(norad)}`);
            if (!r.ok) throw new Error(String(r.status));
            data = await r.json();
        } catch (err) {
            setText('dossier-status', `catalog record unavailable (${err.message})`);
            return;
        }

        const o = data.object;
        setText('dossier-name', `// ${o.OBJECT_NAME || 'UNNAMED'}`);
        setText('dossier-designator', o.OBJECT_ID || '—');
        setText('d-norad', o.NORAD_CAT_ID);
        setText('d-type', o.OBJECT_TYPE || '—');
        setText('d-country', o.COUNTRY_CODE || '—');
        setText('d-launch', o.LAUNCH_DATE || '—');
        setText('d-site', o.SITE || o.satcat_site || '—');
        setText('d-rcs', o.RCS_SIZE ? `${o.RCS_SIZE}${o.satcat_rcs_m2 ? ` · ${o.satcat_rcs_m2} m²` : ''}` : '—');
        setText('d-regime', o.regime || '—');
        setText('d-period', o.PERIOD != null ? `${Number(o.PERIOD).toFixed(1)} min` : '—');
        setText('d-apogee', o.apogee_km != null ? `${Math.round(o.apogee_km)} km` : '—');
        setText('d-perigee', o.perigee_km != null ? `${Math.round(o.perigee_km)} km` : '—');
        setText('d-incl', o.INCLINATION != null ? `${Number(o.INCLINATION).toFixed(2)}°` : '—');
        setText('d-epoch', relTime(o.EPOCH));

        if (!dossierSatrec && o.TLE_LINE1 && o.TLE_LINE2) {
            try {
                const satrec = satellite.twoline2satrec(o.TLE_LINE1, o.TLE_LINE2);
                dossierSatrec = satrec;
                dossierVisuals = engine.addInspectVisuals({ satrec, l1: o.TLE_LINE1, l2: o.TLE_LINE2 }, '#ffffff');
                refreshLive();
                if (dossierTimer) clearInterval(dossierTimer);
                dossierTimer = engine.own(setInterval(refreshLive, 1000));
                startTrail();
            } catch (_) { }
        }

        State.set('selectedObject', {
            norad: o.NORAD_CAT_ID,
            name: o.OBJECT_NAME,
            type: o.OBJECT_TYPE,
            regime: o.regime || '',
            l1: o.TLE_LINE1,
            l2: o.TLE_LINE2,
        });

        const decayEl = $('dossier-decay');
        if (decayEl) {
            const next = (data.decay || [])[0];
            decayEl.hidden = !next && !o.DECAY_DATE;
            if (o.DECAY_DATE) {
                decayEl.textContent = `DECAYED ${o.DECAY_DATE}`;
                decayEl.className = 'st-dossier__decay st-dossier__decay--done';
            } else if (next) {
                decayEl.textContent = `REENTRY PREDICTED ${next.DECAY_EPOCH} (${next.SOURCE || 'TIP'})`;
                decayEl.className = 'st-dossier__decay';
            }
        }

        setText('dossier-status', o.operator_derived
            ? `operator: ${o.operator} — inferred from the name, not a Space-Track field`
            : '');
    }

    return { open, close, refreshLive };
}
