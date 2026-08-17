import { apiFetch } from '../api.js';

export default {
  id: 'feedback',
  title: 'FEEDBACK',
  order: 6,
  refreshMs: 120000,

  async load() {
    return apiFetch('/api/admin/feedback');
  },

  badge(data) {
    const n = data?.unreviewed ?? 0;
    if (!n) return { state: 'ok', label: 'all reviewed' };
    return { state: 'bad', label: `${n} unreviewed` };
  },

  render(el, data, ctx) {
    el.replaceChildren();

    if (data?.error) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.textContent = data.error;
      el.appendChild(p);
      return;
    }

    if (!data?.items?.length) {
      const p = document.createElement('p');
      p.className = 'admin-hint';
      p.textContent = 'No feedback submitted yet.';
      el.appendChild(p);
      return;
    }

    const list = document.createElement('div');
    list.className = 'admin-feedback-list';

    for (const item of data.items) {
      const row = document.createElement('div');
      row.className = 'admin-feedback-item';
      if (item.reviewed) row.classList.add('admin-feedback-item--reviewed');

      const head = document.createElement('div');
      head.className = 'admin-feedback-item__head';

      const kind = document.createElement('span');
      kind.className = `admin-feedback-kind admin-feedback-kind--${item.kind}`;
      kind.textContent = item.kind.toUpperCase();
      head.appendChild(kind);

      const when = document.createElement('span');
      when.className = 'admin-hint';
      when.textContent = new Date(item.ts).toLocaleString();
      head.appendChild(when);

      if (item.path) {
        const path = document.createElement('span');
        path.className = 'admin-hint';
        path.textContent = item.path;
        head.appendChild(path);
      }

      row.appendChild(head);

      const msg = document.createElement('p');
      msg.className = 'admin-feedback-item__message';
      msg.textContent = item.message;
      row.appendChild(msg);

      if (item.email) {
        const email = document.createElement('p');
        email.className = 'admin-hint';
        email.textContent = `reply: ${item.email}`;
        row.appendChild(email);
      }

      const btn = document.createElement('button');
      btn.className = 'admin-btn admin-feedback-item__toggle';
      btn.textContent = item.reviewed ? 'MARK UNREVIEWED' : 'MARK REVIEWED';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await apiFetch('/api/admin/feedback', {
            method: 'POST',
            body: JSON.stringify({ id: item.id, reviewed: item.reviewed ? 0 : 1 }),
          });
          ctx?.reload ? ctx.reload() : location.reload();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = err.message;
        }
      });
      row.appendChild(btn);

      list.appendChild(row);
    }

    el.appendChild(list);
  },
};
