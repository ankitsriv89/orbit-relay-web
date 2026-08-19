import { SatEngine, tuneViewerForDevice, tuneBaseImagery, mountCameraAltitudeHud, flyHome } from '../../orbit-engine/sat-engine.js';
import { State } from './state.js';
import { wireHudToggle } from '/shared/hud.js';

// Dot-tracking view, not a photorealistic map — the CesiumJS-bundled offline
// NaturalEarthII tileset + a plain ellipsoid need no Cesium ion account/token.
const OFFLINE_IMAGERY = () => Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(
        Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
    )
);

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
        baseLayer: OFFLINE_IMAGERY(),
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        ...viewerOptions,
    });
    window.viewer = viewer;

    // Flat, fully-lit globe — object tracking, not a day/night render. Sun-driven
    // terrain lighting hid every satellite on the night hemisphere behind an
    // unlit, near-black Earth; the terminator is not a tracking cue, so the globe
    // is lit uniformly and the atmosphere is left static rather than sun-driven.
    // See also SatEngine's eclipse pass, removed for the same reason.
    viewer.scene.globe.enableLighting          = false;
    viewer.scene.globe.dynamicAtmosphereLighting = false;
    viewer.scene.globe.dynamicAtmosphereLightingFromSun = false;
    viewer.scene.skyAtmosphere.show            = true;
    viewer.scene.skyAtmosphere.hueShift        = 0.0;
    viewer.scene.skyAtmosphere.saturationShift = -0.1;
    // See tuneBaseImagery: the additive atmosphere rim over the bright offline
    // imagery left a blown-out cyan halo at the old -0.1.
    viewer.scene.skyAtmosphere.brightnessShift = -0.45;

    // Tone the bright NaturalEarthII base texture down under the deliberately
    // unlit globe above — imagery-layer dials, not lighting. See sat-engine.js.
    tuneBaseImagery(viewer);

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

    // Cinematic quality (plan 34 §3.3): the eclipse pass lives in the shared
    // engine. /spacetrack/ has no toggle of its own — /orbit/ owns the control
    // and persists it under quality.cinematics — so these pages follow the
    // saved level and keep the engine default ('high') when it was never set.
    engine.setCinematics(State.get('quality.cinematics') === 'low' ? 'low' : 'high');

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

    // initGlobe owns its whole lifecycle, including the teardown: the singleton
    // guard above means this registers exactly once, and a page that never calls
    // initGlobe (none today, but the boundary is now explicit) leaks nothing.
    window.addEventListener('beforeunload', destroyGlobe);

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
    container.classList.add('key-hud');
    container.innerHTML = `
        <button class="key-hud-toggle tw-toggle" id="time-warp-toggle" aria-expanded="true" aria-controls="time-warp-body">
            <span class="key-hud-toggle-arrow">▶</span>
            <span class="tw-label">⏱ TIME <span id="tw-current-rate" class="tw-current-rate">1×</span></span>
        </button>
        <div id="time-warp-body" class="key-hud-body tw-body">
            <div class="tw-btns">
                <button class="tw-btn" data-rate="0" title="Pause">❚❚</button>
                <button class="tw-btn tw-btn--active" data-rate="1" title="Real time">1×</button>
                <button class="tw-btn" data-rate="10" title="10× speed">10×</button>
                <button class="tw-btn" data-rate="100" title="100× speed">100×</button>
                <button class="tw-btn" data-rate="1000" title="1000× speed">1000×</button>
            </div>
            <button id="recenter-btn" class="tw-btn recenter-btn" title="Recenter globe" aria-label="Recenter globe">⌖</button>
            <span id="cam-alt" class="cam-alt" aria-label="Camera altitude above the surface"></span>
        </div>
    `;
    if (viewer) mountCameraAltitudeHud(viewer, container.querySelector('#cam-alt'));
    const recenterBtn = container.querySelector('#recenter-btn');
    if (recenterBtn) recenterBtn.addEventListener('click', () => { if (viewer) flyHome(viewer); });
    const currentRateEl = container.querySelector('#tw-current-rate');
    const syncCurrentRateChip = (rate) => {
        if (currentRateEl) currentRateEl.textContent = rate === 0 ? '❚❚' : `${rate}×`;
    };
    document.querySelectorAll('.tw-btn[data-rate]').forEach(btn => {
        btn.addEventListener('click', () => {
            const rate = Number(btn.dataset.rate);
            setTimeRate(rate);
            document.querySelectorAll('.tw-btn[data-rate]').forEach(b => b.classList.toggle('tw-btn--active', b === btn));
            syncCurrentRateChip(rate);
        });
    });
    const savedRate = normalizeTimeRate(State.get('time.rate'));
    if (savedRate != null) {
        setTimeRate(savedRate);
        document.querySelectorAll('.tw-btn[data-rate]').forEach(b => b.classList.toggle('tw-btn--active', Number(b.dataset.rate) === savedRate));
        syncCurrentRateChip(savedRate);
    }
    wireHudToggle('time-warp', 'time-warp-toggle', 'time-warp-body', { exclusive: 'never' });
}

/** Legacy saved rates (0/1/60/600) map to the nearest new preset
 *  (0/1/10/100/1000) so a returning visitor's localStorage value still
 *  picks a real button rather than landing on an orphaned rate. */
const TIME_RATE_OPTIONS = [0, 1, 10, 100, 1000];
const LEGACY_TIME_RATE_MAP = { 0: 0, 1: 1, 60: 10, 600: 1000 };

export function normalizeTimeRate(rate) {
    if (rate == null) return null;
    const n = Number(rate);
    if (TIME_RATE_OPTIONS.includes(n)) return n;
    if (n in LEGACY_TIME_RATE_MAP) return LEGACY_TIME_RATE_MAP[n];
    return TIME_RATE_OPTIONS.reduce((closest, opt) =>
        Math.abs(opt - n) < Math.abs(closest - n) ? opt : closest, TIME_RATE_OPTIONS[0]);
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
