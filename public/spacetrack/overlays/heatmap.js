import { $ } from '../shared/utils.js';
import { binHeatmap, heatmapStyle } from '../catalog/compute.js';

/**
 * Density heatmap overlay. Wires the DOM toggle and camera listeners itself;
 * catalog.js only constructs it via createHeatmap({ viewer, getRendered }).
 * Pure math lives in ../catalog/compute.js (unit-tested in Node).
 */
export function createHeatmap({ viewer, getRendered }) {
    const heatmapCanvas = $('density-heatmap');
    const heatCtx = heatmapCanvas?.getContext('2d');
    let heatmapVisible = false;
    const HEAT_BIN = 6; // pixel bin size for density counting

    function resizeHeatmap() {
        if (!heatmapCanvas) return;
        heatmapCanvas.width = window.innerWidth;
        heatmapCanvas.height = window.innerHeight;
    }

    function renderHeatmap() {
        if (!heatCtx || !heatmapVisible || !getRendered().length) return;
        const w = heatmapCanvas.width;
        const h = heatmapCanvas.height;
        heatCtx.clearRect(0, 0, w, h);

        const coords = [];
        for (const sat of getRendered()) {
            if (!sat.primitive.show || !sat.primitive.position) continue;
            const c2s = Cesium.SceneTransforms.wgs84ToWindowCoordinates(
                viewer.scene, sat.primitive.position);
            if (!c2s) continue;
            coords.push([c2s.x, c2s.y]);
        }
        const { bins, max } = binHeatmap(coords, HEAT_BIN);
        if (!bins.length || max < 2) return;

        for (const b of bins) {
            const { radius, alpha, r, g, b: blue } = heatmapStyle(b.count, max, HEAT_BIN);
            heatCtx.beginPath();
            heatCtx.arc(
                b.x * HEAT_BIN + HEAT_BIN / 2,
                b.y * HEAT_BIN + HEAT_BIN / 2,
                radius, 0, Math.PI * 2);
            heatCtx.fillStyle = `rgba(${r},${g},${blue},${alpha})`;
            heatCtx.fill();
        }
    }

    resizeHeatmap();
    window.addEventListener('resize', resizeHeatmap);

    const heatmapToggle = $('heatmap-toggle');
    if (heatmapToggle) {
        heatmapToggle.addEventListener('click', () => {
            heatmapVisible = !heatmapVisible;
            heatmapToggle.textContent = heatmapVisible ? 'ON' : 'OFF';
            heatmapToggle.classList.toggle('st-toggle-btn--on', heatmapVisible);
            if (heatmapCanvas) heatmapCanvas.classList.toggle('is-visible', heatmapVisible);
            if (heatmapVisible) renderHeatmap();
            else if (heatCtx) heatCtx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height);
        });
    }

    viewer.camera.changed.addEventListener(() => { if (heatmapVisible) renderHeatmap(); });
    viewer.camera.moveEnd.addEventListener(() => { if (heatmapVisible) renderHeatmap(); });

    return {
        get visible() { return heatmapVisible; },
        render: renderHeatmap,
    };
}
