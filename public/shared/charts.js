/**
 * public/shared/charts.js — pure SVG/CSS chart primitives for the Analytics
 * and Brief dashboards (plan 38). No framework, no `innerHTML` — every
 * renderer builds DOM nodes directly, per the repo's no-innerHTML rule.
 *
 *     node workers/orbit-ingest/test/charts.test.mjs
 *
 * `bin`, `cumulative` and `niceScale` are pure and Node-testable with no
 * browser globals. The render functions (`bars`, `stackedBars`, `svgLine`,
 * `svgHistogram`) touch `document` and are exercised only in the browser —
 * the maths they depend on is what the test suite pins.
 *
 * Reduced motion: every renderer that sets a CSS transition-bearing class
 * respects `prefers-reduced-motion` by adding `.charts-reduced-motion` to the
 * container, which callers' CSS should gate on (see spacetrack.css's chart
 * block). This is the first reduced-motion handling in the repo — CLAUDE.md
 * notes charts are where it starts.
 */

const PREFERS_REDUCED_MOTION = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;

/**
 * Bin numeric values into fixed-width buckets over [min, max].
 *
 * The last bin includes its upper edge (values === max land in the final
 * bucket, not overflow) — a naive `Math.floor((v - min) / width)` puts a
 * value exactly at `max` one bucket past the end when `(max - min)` divides
 * evenly by `width`. Values outside [min, max] are dropped, not clamped: a
 * dashboard axis has an explicit domain and out-of-range data should not
 * silently pile into the edge bins.
 */
export function bin(values, { min, max, width }) {
    const count = Math.max(1, Math.ceil((max - min) / width));
    const buckets = new Array(count).fill(0);
    for (const v of values) {
        if (v == null || Number.isNaN(v) || v < min || v > max) continue;
        let idx = Math.floor((v - min) / width);
        if (idx >= count) idx = count - 1; // value === max lands in the last bin
        if (idx < 0) idx = 0;
        buckets[idx]++;
    }
    return buckets.map((n, i) => ({
        min: min + i * width,
        max: Math.min(max, min + (i + 1) * width),
        n,
    }));
}

/**
 * Running total of `rows[i][valueKey]`, carried forward across gaps.
 *
 * Rows are assumed pre-sorted by their natural key (e.g. year); this function
 * does not sort or fill missing keys — it only accumulates in the order
 * given. A gap in the input (e.g. no launches recorded for 1957) is simply
 * absent from the output, not a break in the running sum: the next row's
 * cumulative value still includes everything before it. A naive
 * implementation that resets or re-bases per row would understate every
 * total after a gap.
 */
export function cumulative(rows, valueKey) {
    let total = 0;
    const out = [];
    for (const row of rows) {
        total += Number(row[valueKey]) || 0;
        out.push({ ...row, cumulative: total });
    }
    return out;
}

/**
 * Pick a "nice" axis step (1/2/5 × 10^n) for `ticks` divisions of [min, max].
 * Returns { min, max, step, ticks: [values] } with the domain snapped
 * outward to whole steps so the first/last gridline is not a fraction.
 */
export function niceScale(min, max, ticks = 5) {
    if (max <= min) return { min, max: min + 1, step: 1, ticks: [min, min + 1] };
    const rawStep = (max - min) / Math.max(1, ticks);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    const step = niceNorm * mag;
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const values = [];
    for (let v = niceMin; v <= niceMax + step / 2; v += step) values.push(Math.round(v * 1e6) / 1e6);
    return { min: niceMin, max: niceMax, step, ticks: values };
}

/**
 * Country/boxscore-style orbital-vs-decayed stacked segment, shared by Brief's
 * boxscore rows and Analytics' cohort-survival chart. Moved out of brief.js
 * (plan 38 task 1, open decision #3) so the stacked-bar split has one
 * implementation instead of a second copy the day `stackedBars` ships.
 */
export function boxSegments(row, maxTotal) {
    const total = row.COUNTRY_TOTAL || 0;
    const orbital = row.ORBITAL_TOTAL_COUNT;
    const decayed = row.DECAYED_TOTAL_COUNT;
    const bar = total > 0 ? (total / maxTotal) * 100 : 0;
    const base = Math.max(orbital, 0) + Math.max(decayed, 0);
    const orbitalPct = base > 0 ? (Math.max(orbital, 0) / base) * 100 : 100;
    return { bar, orbitalPct, decayedPct: 100 - orbitalPct };
}

function applyMotionClass(container) {
    if (PREFERS_REDUCED_MOTION) container.classList.add('charts-reduced-motion');
}

/**
 * Horizontal bar list — reuses the existing `.st-bar` / `.st-bar__track` /
 * `.st-bar__fill` / `.st-bar__value` classes from spacetrack.css so bars
 * built via this module are visually identical to the hand-rolled ones they
 * replace.
 */
export function bars(container, rows, { label, value, color, max } = {}) {
    container.textContent = '';
    applyMotionClass(container);
    if (!rows || !rows.length) return;
    const labelFn = label || ((r) => String(r.label));
    const valueFn = value || ((r) => r.n);
    const peak = max != null ? max : Math.max(...rows.map(valueFn));
    if (!peak) return;

    for (const row of rows) {
        const v = valueFn(row);
        const pct = (v / peak) * 100;

        const bar = document.createElement('div');
        bar.className = 'st-bar';

        const lbl = document.createElement('span');
        lbl.className = 'st-bar__label';
        lbl.textContent = labelFn(row);
        lbl.title = labelFn(row);

        const track = document.createElement('div');
        track.className = 'st-bar__track';
        const fill = document.createElement('div');
        fill.className = 'st-bar__fill';
        fill.style.width = `${pct}%`;
        if (color) fill.style.background = color(row);
        fill.title = String(v);
        track.appendChild(fill);

        const val = document.createElement('span');
        val.className = 'st-bar__value';
        val.textContent = String(v);

        bar.append(lbl, track, val);
        container.appendChild(bar);
    }
}

/**
 * Multi-segment stacked bar (orbital/decayed cohort survival, boxscore
 * country rows). `segments` is an array of `{ value(row), color(row), label }`
 * evaluated per row; segment widths are each segment's share of the row's own
 * total, not the global max — the *bar's* length (vs the global max) shows
 * magnitude, the *segments within it* show composition.
 */
export function stackedBars(container, rows, { label, segments, max } = {}) {
    container.textContent = '';
    applyMotionClass(container);
    if (!rows || !rows.length || !segments || !segments.length) return;
    const labelFn = label || ((r) => String(r.label));
    const rowTotal = (row) => segments.reduce((sum, s) => sum + Math.max(0, Number(s.value(row)) || 0), 0);
    const peak = max != null ? max : Math.max(...rows.map(rowTotal));
    if (!peak) return;

    for (const row of rows) {
        const total = rowTotal(row);
        const bar = document.createElement('div');
        bar.className = 'st-bar';

        const lbl = document.createElement('span');
        lbl.className = 'st-bar__label';
        lbl.textContent = labelFn(row);
        lbl.title = labelFn(row);

        const track = document.createElement('div');
        track.className = 'st-bar__track';
        track.style.width = `${peak > 0 ? (total / peak) * 100 : 0}%`;

        for (const seg of segments) {
            const v = Math.max(0, Number(seg.value(row)) || 0);
            if (!v) continue;
            const fill = document.createElement('div');
            fill.className = 'st-bar__fill st-bar__fill--stacked';
            fill.style.width = total > 0 ? `${(v / total) * 100}%` : '0%';
            if (seg.color) fill.style.background = seg.color(row);
            fill.title = `${seg.label || ''}: ${v}`.trim();
            track.appendChild(fill);
        }

        const val = document.createElement('span');
        val.className = 'st-bar__value';
        val.textContent = String(total);

        bar.append(lbl, track, val);
        container.appendChild(bar);
    }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
};

/**
 * Multi-series line chart. `series` is `[{ label, color, points: [{x, y}] }]`
 * sharing one x/y domain derived from all series combined via `niceScale`.
 * Used for Analytics' growth chart (cumulative catalog entries vs still on
 * orbit today — two clearly distinct series, never merged into one curve
 * implying a historical on-orbit profile) and Brief's archive sparkline.
 */
export function svgLine(container, series, { w = 480, h = 220, xLabel = '', yLabel = '' } = {}) {
    container.textContent = '';
    applyMotionClass(container);
    if (!series || !series.length) return;

    const allPoints = series.flatMap((s) => s.points || []);
    if (!allPoints.length) return;

    const xs = allPoints.map((p) => p.x);
    const ys = allPoints.map((p) => p.y);
    const xScale = niceScale(Math.min(...xs), Math.max(...xs), 6);
    const yScale = niceScale(0, Math.max(...ys), 5);

    const padL = 40, padB = 24, padT = 10, padR = 10;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const px = (x) => padL + ((x - xScale.min) / (xScale.max - xScale.min || 1)) * plotW;
    const py = (y) => padT + plotH - ((y - yScale.min) / (yScale.max - yScale.min || 1)) * plotH;

    // preserveAspectRatio is left at its `xMidYMid meet` default deliberately.
    // Setting it to `none` does let the curve fill a wide card instead of
    // letterboxing — but it scales x and y independently, which stretches the
    // TEXT with the geometry: measured on a 1330px card capped at 220px, the
    // tick labels came out visibly letterspaced and the rotated y-axis label
    // squashed. Filling the width is not worth smeared type.
    //
    // The aspect ratio is controlled by the `w`/`h` a caller passes instead —
    // see renderGrowth() in analytics.js, which picks a wide viewBox so the
    // meet-fit lands close to the card's real proportions.
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, class: 'st-chart st-chart--line', role: 'img' });

    for (const gy of yScale.ticks) {
        svg.appendChild(svgEl('line', {
            x1: padL, x2: w - padR, y1: py(gy), y2: py(gy), class: 'st-chart__grid',
        }));
        const t = svgEl('text', { x: padL - 6, y: py(gy) + 3, class: 'st-chart__tick', 'text-anchor': 'end' });
        t.textContent = String(Math.round(gy));
        svg.appendChild(t);
    }
    for (const gx of xScale.ticks) {
        const t = svgEl('text', { x: px(gx), y: h - padB + 14, class: 'st-chart__tick', 'text-anchor': 'middle' });
        t.textContent = String(Math.round(gx));
        svg.appendChild(t);
    }

    for (const s of series) {
        const pts = s.points || [];
        if (!pts.length) continue;
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${px(p.x)} ${py(p.y)}`).join(' ');
        const path = svgEl('path', { d, class: 'st-chart__line', fill: 'none' });
        if (s.color) path.style.stroke = s.color;
        svg.appendChild(path);
    }

    if (xLabel) {
        const t = svgEl('text', { x: w / 2, y: h - 2, class: 'st-chart__axis-label', 'text-anchor': 'middle' });
        t.textContent = xLabel;
        svg.appendChild(t);
    }
    if (yLabel) {
        const t = svgEl('text', {
            x: 10, y: h / 2, class: 'st-chart__axis-label', 'text-anchor': 'middle',
            transform: `rotate(-90 10 ${h / 2})`,
        });
        t.textContent = yLabel;
        svg.appendChild(t);
    }

    container.appendChild(svg);

    if (series.length > 1) {
        const legend = document.createElement('div');
        legend.className = 'st-chart__legend';
        for (const s of series) {
            const item = document.createElement('span');
            item.className = 'st-chart__legend-item';
            if (s.color) item.style.setProperty('--legend-color', s.color);
            item.textContent = s.label || '';
            legend.appendChild(item);
        }
        container.appendChild(legend);
    }
}

/**
 * Histogram of pre-binned rows (from `bin()`). `unit` is appended to axis
 * tick labels (e.g. "km", "deg") — histograms here are always approximations
 * over live, on-orbit-only data, so callers should also render an `approx`
 * hint alongside this chart per the plan's labeling requirement.
 */
export function svgHistogram(container, bins, { w = 480, h = 220, unit = '' } = {}) {
    container.textContent = '';
    applyMotionClass(container);
    if (!bins || !bins.length) return;

    const padL = 40, padB = 24, padT = 10, padR = 10;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const maxN = Math.max(...bins.map((b) => b.n));
    if (!maxN) return;

    const barW = plotW / bins.length;
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, class: 'st-chart st-chart--histogram', role: 'img' });

    bins.forEach((b, i) => {
        const barH = (b.n / maxN) * plotH;
        const rect = svgEl('rect', {
            x: padL + i * barW + 1,
            y: padT + plotH - barH,
            width: Math.max(1, barW - 2),
            height: barH,
            class: 'st-chart__bar',
        });
        rect.appendChild(svgEl('title')).textContent = `${b.min}–${b.max}${unit}: ${b.n}`;
        svg.appendChild(rect);
    });

    const first = bins[0], last = bins[bins.length - 1];
    const tFirst = svgEl('text', { x: padL, y: h - padB + 14, class: 'st-chart__tick', 'text-anchor': 'start' });
    tFirst.textContent = `${first.min}${unit}`;
    const tLast = svgEl('text', { x: w - padR, y: h - padB + 14, class: 'st-chart__tick', 'text-anchor': 'end' });
    tLast.textContent = `${last.max}${unit}`;
    svg.append(tFirst, tLast);

    container.appendChild(svg);
}
