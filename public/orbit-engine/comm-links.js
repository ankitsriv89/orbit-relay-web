/**
 * Comm-link animation — visualizes ground-to-satellite RF links as thin lines
 * that appear only during active visibility windows.
 *
 * Uses Cesium.PolylineCollection (a primitive collection, siblings with the
 * existing PointPrimitiveCollection pattern) — NOT viewer.entities, so it is
 * cleaned up by engine.destroy() via addManagedEntity / removeManagedEntity.
 *
 * Scope: ground-to-satellite only, tied to Signal's selected object + ground-
 * station model. Inter-satellite (sat-to-sat) links are out of scope — no data
 * establishes real link topology between satellites.
 *
 * The "which station-pairs are linked right now" selection logic is extracted
 * into a pure function (same pattern as signal-compute.test.mjs) so it can be
 * unit-tested outside a Cesium render loop.
 */

import { stationEcfMetres } from './astro.js';

/**
 * Given a satellite ECF position and a ground-station ECF position, returns
 * whether a link should be visible at this moment, based on whether the satellite
 * is above the horizon for that station.
 *
 * This is a pure function — no Cesium, no Date, no DOM. It takes the current
 * satellite position and station position and returns a boolean.
 *
 * @param {{x:number, y:number, z:number}} satEcf  Satellite position in ECF metres
 * @param {{x:number, y:number, z:number}} stEcf   Station position in ECF metres
 * @returns {boolean} true if the satellite is above the horizon for the station
 */
export function isSatelliteVisibleToStation(satEcf, stEcf) {
    // Compute the vector from station to satellite
    const dx = satEcf.x - stEcf.x;
    const dy = satEcf.y - stEcf.y;
    const dz = satEcf.z - stEcf.z;

    // The satellite is "visible" if it is above the local horizon,
    // i.e. the dot product of (sat - station) with the local up vector
    // is positive. The local up at the station is the ECF position vector
    // itself (from Earth centre to station).
    const toSatLen = Math.hypot(dx, dy, dz);
    if (toSatLen === 0) return false;

    // Unit vector from station to satellite
    const ux = dx / toSatLen;
    const uy = dy / toSatLen;
    const uz = dz / toSatLen;

    // The station's local "up" direction is the ECF position vector normalized.
    // (From Earth centre to station = local vertical/up)
    const stLen = Math.hypot(stEcf.x, stEcf.y, stEcf.z);
    if (stLen === 0) return false;

    // Dot product: if positive, satellite is above the horizon (not blocked by Earth)
    const dot = (ux * stEcf.x + uy * stEcf.y + uz * stEcf.z) / stLen;

    // Simple horizon check: satellite visible if elevation > 0
    // (dot > 0 means the satellite is above the local horizontal plane)
    return dot > 0;
}

/**
 * Given a ground station select value and the selected satellite's position,
 * returns an array of station ECF positions that have the satellite visible.
 *
 * This is a pure function used by the comm-links renderer to determine which
 * links to draw — it has no Cesium or DOM dependency.
 *
 * @param {{lat:number, lon:number, alt:number}} station   Ground station data
 * @param {{x:number, y:number, z:number}} satEcf         Satellite ECF position
 * @returns {{station: object, visible: boolean}}[]         Per-station visibility
 */
export function getVisibleStations(stations, satEcf) {
    return stations.map((s) => {
        const stEcf = stationEcfMetres({ latDeg: s.lat, lonDeg: s.lon, altKm: s.alt });
        return {
            station: s,
            visible: isSatelliteVisibleToStation(satEcf, stEcf),
        };
    });
}

/**
 * Renders comm links as a Cesium.PolylineCollection. Links are only visible
 * during active visibility windows for the selected satellite and selected
 * ground station.
 *
 * The collection is owned by the engine and routed through addManagedEntity /
 * removeManagedEntity so engine.destroy() covers cleanup.
 *
 * @param {object} engine      The SatEngine instance (has .viewer, .addManagedEntity, .removeManagedEntity)
 * @param {object} selectedSatrec  The selected satellite satrec (has .l1, .l2 for propagation)
 * @param {Array<object>} groundStations  Array of {name, lat, lon, alt} objects
 * @param {function} tickFn  Function that returns the satellite's current ECF position {x, y, z}
 * @returns {{update: function, destroy: function}}  API to update links and destroy them
 */
export function renderCommLinks(engine, selectedSatrec, groundStations, tickFn) {
    let polylineCollection = null;
    let linkLines = [];

    // Create the PolylineCollection the first time
    function ensureCollection() {
        if (!polylineCollection) {
            polylineCollection = engine.addManagedEntity(viewer.entities.add({
                polylineCollection: {
                    geometries: new Map(),
                    color: new Cesium.Color(0.267, 0.965, 0.529, 0.8), // #42f587 with alpha
                    width: 2.0,
                },
            }));
        }
        return polylineCollection;
    }

    return {
        update() {
            if (!selectedSatrec || !engine.viewer) return;

            // Get current satellite ECF position
            const satPos = tickFn();
            if (!satPos) {
                // Hide all links if no satellite position available
                if (polylineCollection) {
                    polylineCollection.show = false;
                }
                return;
            }

            // Determine which stations have the satellite visible
            const visible = getVisibleStations(groundStations, satPos);

            // Update the PolylineCollection
            const collection = ensureCollection();
            collection.show = visible.some((v) => v.visible);

            // Update/link lines for visible stations
            linkLines = [];
            for (const v of visible) {
                if (!v.visible) continue;

                const stEcf = stationEcfMetres({ latDeg: v.station.lat, lonDeg: v.station.lon, altKm: v.station.alt });
                const pos = new Cesium.Cartesian3(stEcf.x, stEcf.y, stEcf.z);
                const satPos3 = new Cesium.Cartesian3(satPos.x, satPos.y, satPos.z);

                // Create or update the line geometry for this station
                let geo = collection.geometries.get(v.station.name);
                if (!geo) {
                    // Create a new polyline geometry for this station
                    geo = {
                        positions: [pos, satPos3],
                        color: new Cesium.Color(0.267, 0.965, 0.529, 0.8),
                        width: 2.0,
                    };
                    collection.geometries.set(v.station.name, geo);
                } else {
                    // Update existing geometry positions
                    geo.positions = [pos, satPos3];
                }
                linkLines.push(geo);
            }

            // Hide lines for stations no longer visible
            for (const key of collection.geometries.keys()) {
                if (!visible.some((v) => v.station.name === key)) {
                    collection.geometries.delete(key);
                }
            }

            // Request render only if visibility changed
            engine.requestRender();
        },

        destroy() {
            if (polylineCollection) {
                engine.removeManagedEntity(polylineCollection);
                polylineCollection = null;
            }
            linkLines = [];
        },
    };
}