import { apiFetch } from '../api.js';

export default {
  id: 'health',
  title: 'SYSTEM HEALTH',
  order: 0,
  open: true,
  refreshMs: 60000,

  async load() {
    return apiFetch('/api/admin/health');
  },

  render(el, data) {
    el.replaceChildren();
    if (!data) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.textContent = 'No data available.';
      el.appendChild(p);
      return;
    }

    const stats = [
      ['Objects', data.objects?.toLocaleString() ?? '—'],
      ['Payloads', data.payloads?.toLocaleString() ?? '—'],
      ['Debris', data.debris?.toLocaleString() ?? '—'],
      ['API calls (1h)', data.apiCalls1h?.toLocaleString() ?? '—'],
      ['Latest ingest', data.latestIngest ? `${data.latestIngest.job} (${data.latestIngest.ok ? 'OK' : 'FAILED'})` : '—'],
      ['Artifact freshness', data.artifactAge ?? '—'],
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
  },
};
