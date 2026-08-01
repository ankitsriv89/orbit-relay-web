import { SatEngine, tuneViewerForDevice, mountCameraAltitudeHud, flyHome } from '../../orbit-engine/sat-engine.js';
import { State } from './state.js';

Cesium.Ion.defaultAccessToken =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJqdGkiOiI2MjFjZDg5My0zMTRiLTQ3ZjMtOTNlNi1iM2E3ZGNjYWE5ZTQiLCJpZCI6MzkzOTM1LCJpYXQiOjE3NzE5Nzk4NTd9.' +
    'eAH51ApKzzuBIkgwf-rqo4G2U6cSBOQMTPFAALBb2Hg';

let viewer = null;
let engine = null;
let clock = null;

export function initGlobe(containerId = 'cesium-container', viewerOptions = {}) {
    if (viewer) return { viewer, engine };

    viewer = new Cesium.Viewer(containerId, {
        animation: false, baseLayerPicker: false, fullscreenButton: false,
        geocoder: false, homeButton: false, infoBox: false, sceneModePicker: false,
        selectionIndicator: false, timeline: false, navigationHelpButton: false,
        shouldAnimate: true,
        ...viewerOptions,
    });
    window.viewer = viewer;

    viewer.scene.globe.enableLighting = true;
    viewer.scene.globe.dynamicAtmosphereLighting = true;
    viewer.scene.globe.dynamicAtmosphereLightingFromSun = true;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.saturationShift = -0.1;
    viewer.scene.skyAtmosphere.brightnessShift = -0.1;
    viewer.scene.globe.nightFadeOutDistance = 1.0e7;
    viewer.scene.globe.nightFadeInDistance = 5.0e7;

    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
        Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    tuneViewerForDevice(viewer);

    const savedCamera = State.get('camera.position');
    if (savedCamera) {
        viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(savedCamera.longitude, savedCamera.latitude, savedCamera.height) });
    } else {
        viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(20, 25, 40000000) });
    }

    clock = viewer.clock;
    clock.shouldAnimate = true;
    clock.multiplier = State.get('time.rate') || 1;

    engine = new SatEngine({ viewer });

    viewer.camera.changed.addEventListener(() => {
        const pos = viewer.camera.positionCartographic;
        if (pos) {
            State.set('camera.position', {
                longitude: Cesium.Math.toDegrees(pos.longitude),
                latitude: Cesium.Math.toDegrees(pos.latitude),
                height: pos.height,
            });
        }
    });

    return { viewer, engine };
}

export function getEngine() { return engine; }
export function getViewer() { return viewer; }
export function getClock() { return clock; }

export function setTimeRate(rate) {
    if (!clock) return;
    if (rate === 0) clock.shouldAnimate = false;
    else { clock.shouldAnimate = true; clock.multiplier = rate; }
    State.set('time.rate', rate);
}

export function initTimeWarpButtons(container) {
    if (!container) {
        container = document.getElementById('time-warp');
        if (!container) return;
    }
    container.innerHTML = `
        <span class="tw-label">⏱ TIME</span>
        <div class="tw-btns">
            <button class="tw-btn" data-rate="0" title="Pause">❚❚</button>
            <button class="tw-btn tw-btn--active" data-rate="1" title="Real time">1×</button>
            <button class="tw-btn" data-rate="60" title="60× speed">60×</button>
            <button class="tw-btn" data-rate="600" title="600× speed">600×</button>
        </div>
        <button id="recenter-btn" class="tw-btn recenter-btn" title="Recenter globe" aria-label="Recenter globe">⌖</button>
        <span id="cam-alt" class="cam-alt" aria-label="Camera altitude above the surface"></span>
    `;
    if (viewer) mountCameraAltitudeHud(viewer, container.querySelector('#cam-alt'));
    const recenterBtn = container.querySelector('#recenter-btn');
    if (recenterBtn) recenterBtn.addEventListener('click', () => { if (viewer) flyHome(viewer); });
    document.querySelectorAll('.tw-btn[data-rate]').forEach(btn => {
        btn.addEventListener('click', () => {
            const rate = Number(btn.dataset.rate);
            setTimeRate(rate);
            document.querySelectorAll('.tw-btn[data-rate]').forEach(b => b.classList.toggle('tw-btn--active', b === btn));
        });
    });
    const savedRate = State.get('time.rate');
    if (savedRate != null) {
        setTimeRate(savedRate);
        document.querySelectorAll('.tw-btn[data-rate]').forEach(b => b.classList.toggle('tw-btn--active', Number(b.dataset.rate) === savedRate));
    }
}

export function destroyGlobe() {
    if (engine) { engine.destroy(); engine = null; }
    if (viewer) { viewer.destroy(); viewer = null; }
}

export function setupMobileMQ(onChange) {
    const mq = window.matchMedia('(max-width: 768px)');
    const isMobile = () => mq.matches;
    if (onChange) mq.addEventListener('change', () => onChange(isMobile()));
    return { mq, isMobile };
}

window.addEventListener('beforeunload', destroyGlobe);
