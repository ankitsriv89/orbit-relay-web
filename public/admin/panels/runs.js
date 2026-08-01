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
    table.innerHTML = `
      <thead><tr>
        <th>TIME</th><th>JOB</th><th>STATUS</th><th>DURATION</th><th>D1</th><th>R2</th><th>SOURCE</th>
      </tr></thead>
    `;
    const tbody = document.createElement('tbody');

    for (const run of data.runs) {
      const tr = document.createElement('tr');
      const time = new Date(run.ts).toLocaleString();
      tr.innerHTML = `
        <td>${time}</td>
        <td>${run.job}</td>
        <td style="color:${run.ok ? '#0f8' : '#f85'}">${run.ok ? 'OK' : 'FAIL'}</td>
        <td>${run.total_ms != null ? run.total_ms + 'ms' : '—'}</td>
        <td>${run.d1_requests ?? '—'}</td>
        <td>${run.r2_puts ?? '—'}</td>
        <td>${run.source ?? '—'}</td>
      `;
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    el.appendChild(table);
  },
};
