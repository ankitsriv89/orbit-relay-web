/**
 * CesiumJS asset base. Must run before Cesium.js loads — it is how the library
 * finds its own workers, shaders and widget assets.
 *
 * A separate file rather than an inline <script> because inline script blocks
 * are not allowed in this repo's HTML.
 */
window.CESIUM_BASE_URL = 'https://cesium.com/downloads/cesiumjs/releases/1.113/Build/Cesium/';
