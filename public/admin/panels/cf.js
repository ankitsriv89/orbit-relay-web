import { apiFetch } from '../api.js';

export default {
  id: 'cf',
  title: 'CLOUDFLARE ANALYTICS',
  order: 3,
  refreshMs: 300000,

  async load() {
    return apiFetch('/api/admin/cf-analytics');
  },

  render(el, data) {
    el.innerHTML = '';

    if (data?.error) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.textContent = data.error;
      el.appendChild(p);
      return;
    }

    if (!data?.days?.length) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.textContent = 'No analytics data available.';
      el.appendChild(p);
      return;
    }

    const table = document.createElement('table');
    table.className = 'admin-table';
    table.innerHTML = '<thead><tr><th>DATE</th><th>REQUESTS</th><th>PAGE VIEWS</th><th>BYTES</th><th>THREATS</th><th>UNIQUES</th></tr></thead>';
    const tbody = document.createElement('tbody');

    for (const d of data.days) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${d.date}</td>
        <td>${(d.requests ?? 0).toLocaleString()}</td>
        <td>${(d.pageViews ?? 0).toLocaleString()}</td>
        <td>${formatBytes(d.bytes)}</td>
        <td>${(d.threats ?? 0).toLocaleString()}</td>
        <td>${(d.uniques ?? 0).toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    el.appendChild(table);
  },
};

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}
