import { apiFetch } from '../api.js';

export default {
  id: 'visitors',
  title: 'VISITORS',
  order: 2,
  refreshMs: 300000,

  async load() {
    return apiFetch('/api/admin/visitors');
  },

  render(el, data) {
    el.replaceChildren();

    if (data?.error) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.textContent = data.error;
      el.appendChild(p);
      return;
    }

    if (!data) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.textContent = 'No visitor data available.';
      el.appendChild(p);
      return;
    }

    const stats = [
      ['Today', `${data.today ?? 0} views`],
      ['This week', `${data.thisWeek ?? 0} views`],
      ['Unique today', `${data.uniqueToday ?? 0}`],
    ];

    for (const [label, value] of stats) {
      const row = document.createElement('div');
      row.className = 'admin-stat';
      const lbl = document.createElement('span');
      lbl.className = 'admin-stat__label';
      lbl.textContent = label;
      const val = document.createElement('span');
      val.className = 'admin-stat__value';
      val.textContent = value;
      row.appendChild(lbl);
      row.appendChild(val);
      el.appendChild(row);
    }

    if (data.topPages?.length) {
      const heading = document.createElement('p');
      heading.style.cssText = 'margin:12px 0 4px;color:var(--c-signal);font-size:0.6rem;letter-spacing:1px;';
      heading.textContent = '// TOP PAGES';
      el.appendChild(heading);

      const table = document.createElement('table');
      table.className = 'admin-table';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      for (const h of ['PAGE', 'VIEWS']) {
        const th = document.createElement('th');
        th.textContent = h;
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const row of data.topPages) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = row.path;
        const td2 = document.createElement('td');
        td2.textContent = row.views;
        tr.appendChild(td1);
        tr.appendChild(td2);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      el.appendChild(table);
    }

    if (data.byCountry?.length) {
      const heading = document.createElement('p');
      heading.style.cssText = 'margin:16px 0 4px;color:var(--c-signal);font-size:0.6rem;letter-spacing:1px;';
      heading.textContent = '// BY COUNTRY (7d)';
      el.appendChild(heading);

      const max = data.byCountry[0]?.views || 1;
      const list = document.createElement('div');
      for (const row of data.byCountry) {
        const rowEl = document.createElement('div');
        rowEl.className = 'admin-bar-row';

        const label = document.createElement('span');
        label.className = 'admin-bar-row__label';
        label.textContent = row.country;

        const track = document.createElement('span');
        track.className = 'admin-bar-row__track';
        const fill = document.createElement('span');
        fill.className = 'admin-bar-row__fill';
        fill.style.width = `${Math.max(2, (row.views / max) * 100)}%`;
        track.appendChild(fill);

        const value = document.createElement('span');
        value.className = 'admin-bar-row__value';
        value.textContent = row.views;

        rowEl.appendChild(label);
        rowEl.appendChild(track);
        rowEl.appendChild(value);
        list.appendChild(rowEl);
      }
      el.appendChild(list);
    }

    if (data.byCity?.length) {
      const heading = document.createElement('p');
      heading.style.cssText = 'margin:16px 0 4px;color:var(--c-signal);font-size:0.6rem;letter-spacing:1px;';
      heading.textContent = '// VISITOR MAP (7d, by city)';
      el.appendChild(heading);
      el.appendChild(renderMap(data.byCity));
    }
  },
};

const MAP_W = 720;
const MAP_H = 360;

// Equirectangular: lon -180..180 -> x 0..MAP_W, lat 90..-90 -> y 0..MAP_H.
function project(lat, lon) {
  const x = ((lon + 180) / 360) * MAP_W;
  const y = ((90 - lat) / 180) * MAP_H;
  return [x, y];
}

function renderMap(points) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;margin-top:8px;overflow-x:auto;';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${MAP_W} ${MAP_H}`);
  svg.setAttribute('width', '100%');
  svg.style.cssText = 'display:block;min-width:480px;background:rgba(0,210,255,0.03);border:1px solid rgba(0,210,255,0.12);border-radius:4px;';

  // Graticule: equator + tropics/polar circles, prime meridian + every 30deg.
  const graticule = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  graticule.setAttribute('stroke', 'rgba(0,210,255,0.1)');
  graticule.setAttribute('stroke-width', '1');
  for (let lon = -180; lon <= 180; lon += 30) {
    const [x] = project(0, lon);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x); line.setAttribute('x2', x);
    line.setAttribute('y1', 0); line.setAttribute('y2', MAP_H);
    graticule.appendChild(line);
  }
  for (const lat of [-60, -30, 0, 30, 60]) {
    const [, y] = project(lat, 0);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', MAP_W);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('stroke-width', lat === 0 ? '1.5' : '1');
    line.setAttribute('stroke', lat === 0 ? 'rgba(0,210,255,0.22)' : 'rgba(0,210,255,0.1)');
    graticule.appendChild(line);
  }
  svg.appendChild(graticule);

  const border = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  border.setAttribute('x', 0); border.setAttribute('y', 0);
  border.setAttribute('width', MAP_W); border.setAttribute('height', MAP_H);
  border.setAttribute('fill', 'none');
  border.setAttribute('stroke', 'rgba(0,210,255,0.18)');
  svg.appendChild(border);

  const max = points.reduce((m, p) => Math.max(m, p.views), 1);
  const dots = document.createElementNS('http://www.w3.org/2000/svg', 'g');

  const tooltip = document.createElement('div');
  tooltip.style.cssText = 'position:absolute;pointer-events:none;padding:4px 8px;background:rgba(8,18,28,0.96);border:1px solid rgba(0,210,255,0.4);border-radius:3px;font-size:0.6rem;color:var(--c-text);white-space:nowrap;transform:translate(-50%,-130%);display:none;z-index:5;';
  wrap.appendChild(tooltip);

  for (const p of points) {
    const [x, y] = project(p.lat, p.lon);
    const r = 2 + Math.sqrt(p.views / max) * 8;

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', r);
    dot.setAttribute('fill', 'rgba(0,210,255,0.55)');
    dot.setAttribute('stroke', 'var(--c-signal)');
    dot.setAttribute('stroke-width', '1');
    dot.style.cursor = 'pointer';

    const label = `${p.city}, ${p.country} — ${p.views} view${p.views === 1 ? '' : 's'}`;
    dot.addEventListener('mouseenter', () => {
      tooltip.textContent = label;
      tooltip.style.left = `${(x / MAP_W) * 100}%`;
      tooltip.style.top = `${(y / MAP_H) * 100}%`;
      tooltip.style.display = 'block';
    });
    dot.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

    dots.appendChild(dot);
  }
  svg.appendChild(dots);

  wrap.appendChild(svg);
  return wrap;
}
