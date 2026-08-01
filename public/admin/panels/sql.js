import { apiFetch } from '../api.js';

export default {
  id: 'sql',
  title: 'SQL CONSOLE',
  order: 4,

  render(el) {
    el.innerHTML = '';

    const textarea = document.createElement('textarea');
    textarea.className = 'admin-sql-input';
    textarea.placeholder = 'SELECT * FROM objects LIMIT 10';
    textarea.spellcheck = false;

    const btn = document.createElement('button');
    btn.className = 'admin-btn';
    btn.textContent = 'EXECUTE';

    const result = document.createElement('div');
    result.className = 'admin-sql-result';

    btn.addEventListener('click', async () => {
      const sql = textarea.value.trim();
      if (!sql) return;
      btn.disabled = true;
      btn.textContent = 'RUNNING\u2026';
      result.innerHTML = '';

      try {
        const data = await apiFetch('/api/admin/query', {
          method: 'POST',
          body: JSON.stringify({ sql }),
        });

        if (data.error) {
          const hint = document.createElement('p');
          hint.className = 'admin-hint';
          hint.style.color = 'var(--c-warn)';
          hint.textContent = data.error;
          result.appendChild(hint);
          return;
        }

        if (!data.rows?.length) {
          const hint = document.createElement('p');
          hint.className = 'admin-hint';
          hint.textContent = 'Query returned 0 rows.';
          result.appendChild(hint);
          return;
        }

        if (data.truncated) {
          const hint = document.createElement('p');
          hint.className = 'admin-hint';
          hint.textContent = `Results truncated (showing first ${data.rows.length} rows).`;
          result.appendChild(hint);
        }

        const table = document.createElement('table');
        table.className = 'admin-table';
        const cols = Object.keys(data.rows[0]);
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        for (const c of cols) {
          const th = document.createElement('th');
          th.textContent = c;
          hr.appendChild(th);
        }
        thead.appendChild(hr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const row of data.rows) {
          const tr = document.createElement('tr');
          for (const c of cols) {
            const td = document.createElement('td');
            const val = row[c];
            td.textContent = val == null ? 'NULL' : String(val);
            td.title = String(val);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        result.appendChild(table);
      } catch (err) {
        const hint = document.createElement('p');
        hint.className = 'admin-hint';
        hint.style.color = 'var(--c-warn)';
        hint.textContent = err.message;
        result.appendChild(hint);
      } finally {
        btn.disabled = false;
        btn.textContent = 'EXECUTE';
      }
    });

    el.appendChild(textarea);
    el.appendChild(btn);
    el.appendChild(result);
  },
};
