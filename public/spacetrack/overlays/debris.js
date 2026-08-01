import { $ } from '../shared/utils.js';

/**
 * Debris-field altitude bands. All entities are routed through
 * engine.addManagedEntity so destroy() reclaims them. Wired as a self-
 * contained overlay: catalog.js constructs it and calls setEnabled/reset.
 */
export function createDebris({ viewer, engine, getRendered }) {
    let debrisCloudEntities = [];
    let visible = false;

    function build() {
        remove();
        const debrisObjs = getRendered().filter(s => {
            const t = (s.meta?.row?.OBJECT_TYPE || '').toUpperCase();
            return t === 'DEBRIS';
        });
        if (!debrisObjs.length) return;

        const BAND_WIDTH = 200;
        const MIN_ALT = 200;
        const MAX_ALT = 2200;
        const bands = new Map();

        for (const sat of debrisObjs) {
            const alt = sat.meta?.row?.apogee_km ?? sat.meta?.row?.perigee_km ?? 400;
            const band = Math.floor(alt / BAND_WIDTH) * BAND_WIDTH;
            if (band < MIN_ALT || band >= MAX_ALT) continue;
            bands.set(band, (bands.get(band) || 0) + 1);
        }

        if (!bands.size) return;

        let maxCount = 0;
        for (const v of bands.values()) if (v > maxCount) maxCount = v;

        const SEGMENTS = 180;
        for (const [alt, count] of bands) {
            const intensity = Math.min(count / Math.max(maxCount, 1), 1);
            const alpha = 0.06 + intensity * 0.25;
            const width = 0.8 + intensity * 2.5;
            const positions = [];
            for (let i = 0; i <= SEGMENTS; i++) {
                const lon = (i / SEGMENTS) * 360 - 180;
                positions.push(Cesium.Cartesian3.fromDegrees(lon, 0, (alt + BAND_WIDTH / 2) * 1000));
            }
            const entity = engine.addManagedEntity(viewer.entities.add({
                polyline: {
                    positions,
                    width,
                    material: new Cesium.PolylineGlowMaterialProperty({
                        glowPower: 0.12,
                        color: Cesium.Color.fromCssColorString('#ff5f6d').withAlpha(alpha),
                    }),
                    arcType: Cesium.ArcType.NONE,
                },
            }));
            debrisCloudEntities.push(entity);
        }
        engine.requestRender();
    }

    function remove() {
        for (const e of debrisCloudEntities) engine.removeManagedEntity(e);
        debrisCloudEntities = [];
    }

    const toggle = $('debris-cloud-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            visible = !visible;
            toggle.textContent = visible ? 'ON' : 'OFF';
            toggle.classList.toggle('st-toggle-btn--on', visible);
            if (visible) build();
            else remove();
        });
    }

    return {
        get visible() { return visible; },
        build,
        remove,
        reset() {
            if (visible) {
                remove();
                visible = false;
            }
            if (toggle) {
                toggle.textContent = 'OFF';
                toggle.classList.remove('st-toggle-btn--on');
                toggle.disabled = true;
            }
        },
        setEnabled(hasDebris) {
            if (toggle) toggle.disabled = !hasDebris;
        },
    };
}
