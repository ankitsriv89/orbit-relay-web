/**
 * Level-of-detail camera controller. Wires camera.moveEnd itself and operates
 * purely on getRendered()'s current array — catalog.js just constructs it.
 */
export function createLOD({ viewer, engine, getRendered }) {
    const LOD_CLOSE_THRESHOLD = 500000;
    const LOD_FAR_THRESHOLD = 5000000;
    const LOD_CLOSE_CAP = 400;

    function updateLOD() {
        const rendered = getRendered();
        const height = viewer.camera.positionCartographic.height;
        if (height > LOD_FAR_THRESHOLD) {
            for (const sat of rendered) sat.primitive.show = true;
        } else if (height < LOD_CLOSE_THRESHOLD) {
            const camPos = viewer.camera.position;
            const sorted = rendered.map(sat => {
                const pos = sat.primitive.position;
                if (!pos) return { sat, dist: Infinity };
                const dx = pos.x - camPos.x;
                const dy = pos.y - camPos.y;
                const dz = pos.z - camPos.z;
                return { sat, dist: dx * dx + dy * dy + dz * dz };
            }).sort((a, b) => a.dist - b.dist);
            for (let i = 0; i < sorted.length; i++) {
                sorted[i].sat.primitive.show = i < LOD_CLOSE_CAP;
            }
        } else {
            for (const sat of rendered) sat.primitive.show = true;
        }
        engine.requestRender();
    }

    viewer.camera.moveEnd.addEventListener(updateLOD);

    return { update: updateLOD };
}
