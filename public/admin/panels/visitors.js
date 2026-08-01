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
    el.innerHTML = '';

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
      row.innerHTML = `<span class="admin-stat__label">${label}</span><span class="admin-stat__value">${value}</span>`;
      el.appendChild(row);
    }

    if (data.topPages?.length) {
      const heading = document.createElement('p');
      heading.style.cssText = 'margin:12px 0 4px;color:var(--c-signal);font-size:0.6rem;letter-spacing:1px;';
      heading.textContent = '// TOP PAGES';
      el.appendChild(heading);

      const table = document.createElement('table');
      table.className = 'admin-table';
      table.innerHTML = '<thead><tr><th>PAGE</th><th>VIEWS</th></tr></thead>';
      const tbody = document.createElement('tbody');
      for (const row of data.topPages) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${row.path}</td><td>${row.views}</td>`;
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      el.appendChild(table);
    }
  },
};
