import { apiFetch } from '../api.js';

export default {
  id: 'runs',
  title: 'INGEST RUNS',
  order: 1,
  refreshMs: 120000,

  async load() {
    return apiFetch('/api/admin/runs');
  },

  render(el, data) {
    el.innerHTML = '';
    if (!data?.runs?.length) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.textContent = 'No ingest runs recorded yet.';
      el.appendChild(p);
      return;
    }

    const table = document.createElement('table');
    table.className = 'admin-table';

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['TIME', 'JOB', 'STATUS', 'DURATION', 'D1', 'R2', 'SOURCE']) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const run of data.runs) {
      const tr = document.createElement('tr');
      const cells = [
        new Date(run.ts).toLocaleString(),
        run.job,
        run.ok ? 'OK' : 'FAIL',
        run.total_ms != null ? run.total_ms + 'ms' : '—',
        run.d1_requests != null ? String(run.d1_requests) : '—',
        run.r2_puts != null ? String(run.r2_puts) : '—',
        run.source ?? '—',
      ];
      for (let i = 0; i < cells.length; i++) {
        const td = document.createElement('td');
        td.textContent = cells[i];
        if (i === 2) td.style.color = run.ok ? '#0f8' : '#f85';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.appendChild(table);
  },
};
