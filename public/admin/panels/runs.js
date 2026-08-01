import { apiFetch } from '../api.js';
import { nextDue } from '../cron.js';

export default {
  id: 'runs',
  title: 'INGEST RUNS',
  order: 1,
  refreshMs: 120000,

  async load() {
    return apiFetch('/api/admin/runs');
  },

  badge(data) {
    const runs = data?.runs ?? [];
    if (!runs.length) return { state: 'idle', label: 'no runs yet' };
    const failed = runs.filter(r => !r.ok).length;
    if (failed) return { state: 'bad', label: `${failed}/${runs.length} recent runs failed` };
    return { state: 'ok', label: `${runs.length} recent runs OK` };
  },

  render(el, data) {
    el.replaceChildren();

    // Next-due comes from the Actions crons (public/admin/cron.js), NOT
    // wrangler.toml's — those are documented as deployable-and-unused.
    const next = nextDue();
    if (next) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.style.color = 'var(--c-signal)';
      const dt = new Date(next.at);
      const inMs = next.at - Date.now();
      const h = Math.floor(inMs / 3600000);
      const m = Math.round((inMs % 3600000) / 60000);
      p.textContent = `next ${next.job} run · in ${h}h ${m}m (${dt.toISOString().slice(0, 16).replace('T', ' ')}Z)`;
      el.appendChild(p);
    }

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
    for (const h of ['TIME', 'JOB', 'STATUS', 'DURATION', 'D1', 'R2', 'SOURCE', 'STEPS']) {
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

      // Step breakdown: click the run row to expand it. steps is the JSON the
      // ingest persisted; guard parse failures so a corrupt row can't take the
      // panel down.
      const tdSteps = document.createElement('td');
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'show';
      details.appendChild(summary);
      let steps = [];
      try { steps = JSON.parse(run.steps || '[]'); } catch (_) {}
      if (Array.isArray(steps) && steps.length) {
        const inner = document.createElement('table');
        inner.className = 'admin-table';
        const iHead = document.createElement('thead');
        const iHr = document.createElement('tr');
        for (const h of ['STEP', 'OK', 'MS', 'DETAIL']) {
          const th = document.createElement('th');
          th.textContent = h;
          iHr.appendChild(th);
        }
        iHead.appendChild(iHr);
        inner.appendChild(iHead);
        const iBody = document.createElement('tbody');
        for (const s of steps) {
          const r = document.createElement('tr');
          const cells = [
            String(s.name ?? '?'),
            s.ok ? 'ok' : 'FAIL',
            s.ms != null ? String(s.ms) : '—',
            s.error ? String(s.error).slice(0, 120) : '',
          ];
          for (let i = 0; i < cells.length; i++) {
            const td = document.createElement('td');
            td.textContent = cells[i];
            if (i === 1) td.style.color = s.ok ? '#0f8' : '#f85';
            r.appendChild(td);
          }
          iBody.appendChild(r);
        }
        inner.appendChild(iBody);
        details.appendChild(inner);
      } else {
        const hint = document.createElement('p');
        hint.className = 'admin-hint';
        hint.textContent = 'no steps';
        details.appendChild(hint);
      }
      tdSteps.appendChild(details);
      tr.appendChild(tdSteps);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.appendChild(table);
  },
};
