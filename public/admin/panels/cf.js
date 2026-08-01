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
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const h of ['DATE', 'REQUESTS', 'PAGE VIEWS', 'BYTES', 'THREATS', 'UNIQUES']) {
      const th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const d of data.days) {
      const tr = document.createElement('tr');
      const cells = [
        d.date,
        (d.requests ?? 0).toLocaleString(),
        (d.pageViews ?? 0).toLocaleString(),
        formatBytes(d.bytes),
        (d.threats ?? 0).toLocaleString(),
        (d.uniques ?? 0).toLocaleString(),
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
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
