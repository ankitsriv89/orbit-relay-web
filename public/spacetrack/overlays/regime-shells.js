import { $ } from '../shared/utils.js';

/**
 * Altitude-band shell rings (spec #13). Same two-ring-glow construction the
 * GEO belt originally used (catalog.js pre-S9) applied to all four regimes —
 * altitude thresholds match orbitRegime() in orbit-engine/astro.js so the
 * rings line up with what the dossier calls each object's regime.
 */
const SHELLS = [
    { key: 'LEO', altKm: 1200,  color: '#4ee2ff' },
    { key: 'MEO', altKm: 20200, color: '#8effa0' },
    { key: 'GEO', altKm: 35786, color: '#ffe066' },
    { key: 'HEO', altKm: 39000, color: '#ff6ec7' },
];
const SEGMENTS = 180;
const RING_OFFSET_KM = 200;

function ringPositions(altKm) {
    const positions = [];
    for (let i = 0; i <= SEGMENTS; i++) {
        const lon = (i / SEGMENTS) * 360 - 180;
        positions.push(Cesium.Cartesian3.fromDegrees(lon, 0, altKm * 1000));
    }
    return positions;
}

/**
 * Regime shell rings. Static geometry — unlike debris/launch-sites this
 * doesn't derive from the query results, so it is built once and is not
 * part of clearRendered()'s reset cycle. Entity lifecycle via
 * engine.addManagedEntity so engine.destroy() cleans them up. Defaults to
 * visible (matching the always-on GEO belt this replaces); the toggle can
 * hide all four bands at once since they're busier together than the
 * single GEO ring was.
 */
export function createRegimeShells({ viewer, engine }) {
    let entities = [];
    let visible = true;

    function build() {
        remove();
        for (const shell of SHELLS) {
            const color = Cesium.Color.fromCssColorString(shell.color);
            entities.push(engine.addManagedEntity(viewer.entities.add({
                polyline: {
                    positions: ringPositions(shell.altKm),
                    width: 1.2,
                    material: new Cesium.PolylineGlowMaterialProperty({
                        glowPower: 0.15,
                        color: color.withAlpha(0.25),
                    }),
                    arcType: Cesium.ArcType.NONE,
                },
            })));
            entities.push(engine.addManagedEntity(viewer.entities.add({
                polyline: {
                    positions: ringPositions(shell.altKm + RING_OFFSET_KM),
                    width: 0.6,
                    material: new Cesium.PolylineGlowMaterialProperty({
                        glowPower: 0.08,
                        color: color.withAlpha(0.12),
                    }),
                    arcType: Cesium.ArcType.NONE,
                },
            })));
        }
        engine.requestRender();
    }

    function remove() {
        for (const e of entities) engine.removeManagedEntity(e);
        entities = [];
    }

    const toggle = $('regime-shells-toggle');
    if (toggle) {
        toggle.textContent = 'ON';
        toggle.classList.add('st-toggle-btn--on');
        toggle.addEventListener('click', () => {
            visible = !visible;
            toggle.textContent = visible ? 'ON' : 'OFF';
            toggle.classList.toggle('st-toggle-btn--on', visible);
            if (visible) build();
            else remove();
        });
    }

    build();

    return {
        get visible() { return visible; },
        build,
        remove,
    };
}
