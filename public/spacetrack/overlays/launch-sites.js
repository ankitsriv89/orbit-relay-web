import { $ } from '../shared/utils.js';

const LAUNCH_SITES = {
    'CCAFS LC-13':      { lat: 28.488, lon: -80.577 },
    'CCAFS LC-14':      { lat: 28.491, lon: -80.578 },
    'CCAFS LC-17A':     { lat: 28.439, lon: -80.569 },
    'CCAFS LC-17B':     { lat: 28.438, lon: -80.568 },
    'CCAFS LC-20':      { lat: 28.462, lon: -80.567 },
    'CCAFS LC-26A':     { lat: 28.442, lon: -80.569 },
    'CCAFS LC-31':      { lat: 28.493, lon: -80.580 },
    'CCAFS LC-32':      { lat: 28.493, lon: -80.581 },
    'CCAFS LC-34':      { lat: 28.496, lon: -80.582 },
    'CCAFS LC-36':      { lat: 28.487, lon: -80.582 },
    'CCAFS LC-40':      { lat: 28.562, lon: -80.577 },
    'CCAFS LC-41':      { lat: 28.583, lon: -80.583 },
    'CCAFS SLC-40':     { lat: 28.562, lon: -80.577 },
    'CCAFS SLC-41':     { lat: 28.583, lon: -80.583 },
    'VAFB SLC-2E':      { lat: 34.742, lon: -120.572 },
    'VAFB SLC-2W':      { lat: 34.742, lon: -120.574 },
    'VAFB SLC-3E':      { lat: 34.757, lon: -120.601 },
    'VAFB SLC-4E':      { lat: 34.723, lon: -120.572 },
    'VAFB SLC-4W':      { lat: 34.723, lon: -120.574 },
    'VAFB SLC-6':       { lat: 34.740, lon: -120.585 },
    'WFF LC-0A':        { lat: 37.830, lon: -75.488 },
    'WFF LC-15.64E':    { lat: 37.830, lon: -75.488 },
    'WFF LC-15.64W':    { lat: 37.830, lon: -75.488 },
    'KSC LC-39A':       { lat: 28.608, lon: -80.604 },
    'KSC LC-39B':       { lat: 28.624, lon: -80.606 },
    'KSC LC-39C':       { lat: 28.619, lon: -80.605 },
    'KSC SPACEX LC-39A': { lat: 28.608, lon: -80.604 },
    'KSC UPFF':         { lat: 28.608, lon: -80.604 },
    'MLS':              { lat: 28.410, lon: -80.620 },
    'KODAK':            { lat: 28.410, lon: -80.620 },
    'ELA-1':            { lat: 5.232, lon: -52.767 },
    'ELA-2':            { lat: 5.234, lon: -52.768 },
    'ELA-3':            { lat: 5.236, lon: -52.769 },
    'ELA-4':            { lat: 5.238, lon: -52.770 },
    'SLC-4':            { lat: 5.233, lon: -52.768 },
    'BAIKONUR LC-1':    { lat: 45.965, lon: 63.305 },
    'BAIKONUR LC-31':   { lat: 45.996, lon: 63.282 },
    'BAIKONUR LC-45':   { lat: 46.030, lon: 62.950 },
    'BAIKONUR LC-81/23': { lat: 46.034, lon: 62.937 },
    'BAIKONUR LC-81/24': { lat: 46.034, lon: 62.938 },
    'BAIKONUR LC-90':   { lat: 46.030, lon: 62.950 },
    'PLESETSK LC-41':   { lat: 62.927, lon: 40.682 },
    'PLESETSK LC-43':   { lat: 62.880, lon: 40.741 },
    'PLESETSK LC-133':  { lat: 62.920, lon: 40.575 },
    'PLESETSK LC-158':  { lat: 62.860, lon: 40.820 },
    'TANEGASHIMA LA':   { lat: 30.401, lon: 131.019 },
    'TANEGASHIMA LB':   { lat: 30.397, lon: 130.974 },
    'UCHINOURA':        { lat: 31.252, lon: 131.076 },
    'KAGOSHIMA LP-1':   { lat: 31.783, lon: 130.736 },
    'KAGOSHIMA LP-2':   { lat: 31.774, lon: 130.735 },
    'KAGOSHIMA LC-1':   { lat: 31.774, lon: 130.735 },
    'SEMHAE':           { lat: 39.660, lon: 124.705 },
    'SOHAE':            { lat: 39.660, lon: 124.705 },
    'TONGHAE':          { lat: 39.660, lon: 124.705 },
    'JQU':              { lat: -1.483, lon: 110.453 },
    'XICHANG':          { lat: 28.246, lon: 102.027 },
    'JIUQUAN LC-1':     { lat: 40.959, lon: 100.291 },
    'JIUQUAN LC-2':     { lat: 40.959, lon: 100.292 },
    'TAIYUAN LC-1':     { lat: 38.850, lon: 111.600 },
    'TANDEM':           { lat: -31.615, lon: 115.953 },
    'WOOMERA':          { lat: -31.100, lon: 136.830 },
    'KAPUSTIN YAR LC-3': { lat: 48.567, lon: 45.750 },
    'KAPUSTIN YAR LC-5': { lat: 48.567, lon: 45.750 },
    'KAPUSTIN YAR LC-107': { lat: 48.567, lon: 45.750 },
    'PLESETSK LC-16':   { lat: 62.910, lon: 40.620 },
    'YASNY':            { lat: 51.093, lon: 59.858 },
    'SRIHARIKOTA FLP':  { lat: 13.720, lon: 80.230 },
    'SRIHARIKOTA SLP':  { lat: 13.720, lon: 80.230 },
    'SAC':              { lat: -15.600, lon: -73.980 },
    'SEALY':            { lat: 47.590, lon: -122.610 },
    'MAURITIUS':        { lat: -20.410, lon: 57.680 },
    'SAO TOME':         { lat: 0.330, lon: 6.620 },
    'KOUROU ELD':       { lat: 5.150, lon: -52.650 },
    'KOUROU ELP':       { lat: 5.150, lon: -52.650 },
    'WALLOPS':          { lat: 37.850, lon: -75.488 },
    'MARS':             { lat: 39.733, lon: -77.008 },
    'MARS FLP':         { lat: 39.733, lon: -77.008 },
    'HAMPTON':          { lat: 37.020, lon: -76.340 },
    'MURMANSK':         { lat: 68.950, lon: 33.090 },
    'ASCALON':          { lat: 48.567, lon: 45.750 },
    'CHINHAE':          { lat: 36.400, lon: 127.100 },
    'SWAN':             { lat: -32.000, lon: 115.000 },
    'ALCANTARA':        { lat: -2.300, lon: -44.400 },
    'THUMBA':           { lat: 8.547, lon: 76.874 },
    'HAINAN':           { lat: 19.614, lon: 110.951 },
    'HWANGJU':          { lat: 36.400, lon: 127.100 },
    'YAVNE':            { lat: 31.830, lon: 34.730 },
    'PAMELA':           { lat: 32.000, lon: 34.730 },
    'SVOBODNY':         { lat: 52.040, lon: 128.300 },
    'SVOBODNY-18':      { lat: 52.040, lon: 128.300 },
    'DOMBAROVSKY':      { lat: 51.093, lon: 59.858 },
    'KAPUSTIN YAR':     { lat: 48.567, lon: 45.750 },
    'NENOKSA':          { lat: 64.420, lon: 39.600 },
    'KAP YAR':          { lat: 48.567, lon: 45.750 },
};

/**
 * Launch-site markers. Entity lifecycle is delegated to
 * engine.addManagedEntity/removeManagedEntity; catalog.js constructs it and
 * calls build/remove/reset in sync with re-renders.
 */
export function createLaunchSites({ viewer, engine, getRendered }) {
    let launchSiteEntities = [];
    let visible = false;

    function resolveSiteCoords(siteName) {
        if (!siteName) return null;
        const normalized = siteName.trim().toUpperCase();
        if (LAUNCH_SITES[normalized]) return LAUNCH_SITES[normalized];
        for (const [key, coords] of Object.entries(LAUNCH_SITES)) {
            if (normalized.includes(key) || key.includes(normalized)) return coords;
        }
        return null;
    }

    function build() {
        remove();
        const siteNames = new Map();
        for (const sat of getRendered()) {
            const site = sat.meta?.row?.SITE || sat.meta?.row?.satcat_site;
            if (!site) continue;
            siteNames.set(site, (siteNames.get(site) || 0) + 1);
        }
        for (const [siteName, count] of siteNames) {
            const coords = resolveSiteCoords(siteName);
            if (!coords) continue;
            const entity = engine.addManagedEntity(viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(coords.lon, coords.lat, 0),
                point: {
                    pixelSize: 5,
                    color: Cesium.Color.fromCssColorString('#00d2ff').withAlpha(0.7),
                    outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
                    outlineWidth: 1,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                },
                label: {
                    text: siteName,
                    font: '10px monospace',
                    fillColor: Cesium.Color.fromCssColorString('#00d2ff').withAlpha(0.8),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -8),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY,
                    showBackground: true,
                    backgroundColor: Cesium.Color.fromCssColorString('#000810').withAlpha(0.8),
                    backgroundPadding: new Cesium.Cartesian2(4, 2),
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.2, 1e7, 0.4),
                },
                _siteData: { name: siteName, count },
            }));
            launchSiteEntities.push(entity);
        }
        engine.requestRender();
    }

    function remove() {
        for (const e of launchSiteEntities) engine.removeManagedEntity(e);
        launchSiteEntities = [];
    }

    const toggle = $('launch-sites-toggle');
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
            }
        },
    };
}
