// Landing hero background: a single fullscreen-quad WebGL2 shader —
// starfield + one raymarched planet, no geometry, no scene graph, no
// dependency. Cheaper than an actual 3D engine (Cesium/Three) for a
// decorative backdrop, and this repo has no build step to vendor one
// with anyway. Pauses via IntersectionObserver + document.hidden so it
// never spends GPU time off-screen, and is skipped entirely under
// prefers-reduced-motion (caller decides that).

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
out vec4 fragColor;

float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// Small fixed star layers at different depths/speeds — cheap parallax
// without per-star state or a buffer.
float stars(vec2 uv, float density, float speed, float t) {
    vec2 grid = uv * density;
    vec2 id = floor(grid);
    vec2 f = fract(grid) - 0.5;
    float h = hash(id);
    float r = 0.015 + h * 0.05;
    float d = length(f);
    float twinkle = 0.55 + 0.45 * sin(t * (0.6 + h * 1.4) + h * 30.0);
    float dot_ = smoothstep(r, r * 0.15, d);
    return dot_ * twinkle * step(0.86, h * 1.15);
}

// Sphere-ray intersection for one static planet, lit from one direction.
vec3 planet(vec2 uv, vec3 center, float radius, float t) {
    vec3 ro = vec3(uv, -2.0);
    vec3 rd = normalize(vec3(0.0, 0.0, 1.0));
    vec3 oc = ro - center;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - radius * radius;
    float h = b * b - c;
    if (h < 0.0) return vec3(0.0);
    h = sqrt(h);
    float dist = -b - h;
    vec3 hitPos = ro + rd * dist;
    vec3 n = normalize(hitPos - center);

    vec3 lightDir = normalize(vec3(-0.55, 0.5, -0.6));
    float diff = max(dot(n, lightDir), 0.0);
    float wrap = clamp((dot(n, lightDir) + 0.3) / 1.3, 0.0, 1.0);

    // Cheap procedural "continents" via a couple of rotated noise bands —
    // just enough visual texture to read as a planet, not a photo.
    float lon = atan(n.z, n.x) + t * 0.06;
    float lat = asin(clamp(n.y, -1.0, 1.0));
    float band = sin(lon * 3.0 + lat * 4.0) * 0.5 + 0.5;
    float band2 = hash(floor(vec2(lon, lat) * 8.0));
    float land = smoothstep(0.45, 0.55, band * 0.6 + band2 * 0.4);

    vec3 ocean = mix(vec3(0.01, 0.05, 0.11), vec3(0.02, 0.09, 0.16), wrap);
    vec3 landCol = mix(vec3(0.03, 0.10, 0.09), vec3(0.05, 0.16, 0.14), wrap);
    vec3 surface = mix(ocean, landCol, land);

    float fresnel = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
    vec3 rim = vec3(0.0, 0.82, 1.0) * fresnel * 0.9;

    vec3 lit = surface * (0.15 + diff * 0.9) + rim;
    return lit;
}

void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
    vec3 col = vec3(0.02, 0.031, 0.063); // matches --c-void

    col += vec3(0.55, 0.85, 1.0) * stars(uv + vec2(uTime * 0.002, 0.0), 40.0, 1.0, uTime);
    col += vec3(0.55, 0.85, 1.0) * stars(uv * 1.6 + vec2(uTime * 0.005, 0.03), 70.0, 1.0, uTime * 1.3) * 0.7;
    col += vec3(0.6, 0.9, 1.0) * stars(uv * 2.4 + vec2(uTime * 0.009, -0.02), 110.0, 1.0, uTime * 0.8) * 0.5;

    vec3 pcol = planet(uv, vec3(0.62, -0.32, 0.0), 0.62, uTime);
    col += pcol;

    fragColor = vec4(col, 1.0);
}
`;

function compile(gl, type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`shader compile failed: ${log}`);
    }
    return shader;
}

export function initHeroScene(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) return false;

    let program;
    try {
        const vs = compile(gl, gl.VERTEX_SHADER, VERT);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
        program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program));
        }
    } catch (err) {
        console.warn('[hero-scene] WebGL2 shader setup failed, falling back:', err);
        return false;
    }

    const quad = new Float32Array([-1, -1, 3, -1, -1, 3]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'uRes');
    const uTime = gl.getUniformLocation(program, 'uTime');
    gl.useProgram(program);

    let running = true;
    let visible = true;
    let dpr = Math.min(window.devicePixelRatio || 1, 1.5); // 1.5 cap: this is a decorative backdrop, not the product globe
    let raf = 0;
    const start = performance.now();

    function resize() {
        const parent = canvas.parentElement;
        const w = Math.round(parent.offsetWidth * dpr);
        const h = Math.round(parent.offsetHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            gl.viewport(0, 0, w, h);
        }
    }

    function frame(now) {
        if (!running) return;
        if (visible) {
            resize();
            gl.uniform2f(uRes, canvas.width, canvas.height);
            gl.uniform1f(uTime, (now - start) / 1000);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        raf = requestAnimationFrame(frame);
    }

    const io = new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting && !document.hidden;
    }, { threshold: 0 });
    io.observe(canvas);

    document.addEventListener('visibilitychange', () => {
        visible = !document.hidden && visible;
    });

    window.addEventListener('resize', resize, { passive: true });
    resize();
    raf = requestAnimationFrame(frame);

    return {
        destroy() {
            running = false;
            cancelAnimationFrame(raf);
            io.disconnect();
        },
    };
}
