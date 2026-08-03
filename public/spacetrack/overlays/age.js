import { $ } from '../shared/utils.js';
import { ageColorCss } from '../catalog/compute.js';

/**
 * Object-age coloring. Depends on catalog.js's color-mode machinery via the
 * injected recolorRendered (used to restore type/country colors on toggle-off).
 */
export function createAge({ engine, getRendered, recolorRendered }) {
    let visible = false;

    function ageColor(row) {
        return ageColorCss(row.EPOCH || row.LAUNCH_DATE, Date.now());
    }

    function recolor() {
        for (const sat of getRendered()) {
            const row = sat.meta?.row;
            if (!row) continue;
            const c = ageColor(row);
            if (c) engine.setSatColor(sat, Cesium.Color.fromCssColorString(c));
        }
        engine.requestRender();
    }

    const toggle = $('age-color-toggle');
    const legend = $('age-legend');
    if (toggle) {
        toggle.addEventListener('click', () => {
            visible = !visible;
            toggle.textContent = visible ? 'ON' : 'OFF';
            toggle.classList.toggle('st-toggle-btn--on', visible);
            if (legend) legend.hidden = !visible;
            if (visible) recolor();
            else recolorRendered();
        });
    }

    return {
        get visible() { return visible; },
        recolor,
        reset() {
            if (!visible) return;
            visible = false;
            if (toggle) {
                toggle.textContent = 'OFF';
                toggle.classList.remove('st-toggle-btn--on');
            }
            if (legend) legend.hidden = true;
        },
    };
}
