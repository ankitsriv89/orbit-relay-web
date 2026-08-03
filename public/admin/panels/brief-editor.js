import { apiFetch } from '../api.js';

const today = () => new Date().toISOString().slice(0, 10);

export default {
  id: 'brief-editor',
  title: 'BRIEF EDITOR',
  order: 5,

  // Interactive, not polled — same shape as the SQL console: no `load`, one
  // manual render on activation.
  render(el) {
    el.replaceChildren();

    const intro = document.createElement('p');
    intro.className = 'admin-hint';
    intro.textContent = 'Overwrite a day’s narrative. Facts are untouched. ' +
      'The edit is author-signed — it skips the number-grounding gate but is ' +
      'still checked for the collision/conjunction language block.';
    el.appendChild(intro);

    const dateRow = document.createElement('div');
    dateRow.className = 'admin-stat';
    const dateLabel = document.createElement('span');
    dateLabel.className = 'admin-stat__label';
    dateLabel.textContent = 'Date (UTC)';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'admin-sql-input admin-date-input';
    dateInput.value = today();
    dateRow.appendChild(dateLabel);
    dateRow.appendChild(dateInput);
    el.appendChild(dateRow);

    const loadBtn = document.createElement('button');
    loadBtn.className = 'admin-btn';
    loadBtn.textContent = 'LOAD';
    el.appendChild(loadBtn);

    const textarea = document.createElement('textarea');
    textarea.className = 'admin-sql-input';
    textarea.placeholder = 'Narrative text (60–700 characters)…';
    textarea.rows = 6;
    el.appendChild(textarea);

    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'admin-sql-input';
    noteInput.placeholder = 'Editor note (optional)';
    el.appendChild(noteInput);

    const badge = document.createElement('p');
    badge.className = 'admin-hint';
    el.appendChild(badge);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'admin-btn';
    saveBtn.textContent = 'SAVE';
    el.appendChild(saveBtn);

    const result = document.createElement('div');
    result.className = 'admin-sql-result';
    el.appendChild(result);

    function setResult(text, isError) {
      result.replaceChildren();
      const p = document.createElement('p');
      p.className = 'admin-hint';
      if (isError) p.style.color = 'var(--c-warn)';
      p.textContent = text;
      result.appendChild(p);
    }

    function renderBadge(card) {
      if (!card) { badge.textContent = ''; return; }
      const source = card.narrative_source || 'none';
      badge.textContent = source === 'manual'
        ? 'Currently: Edited (manual)'
        : source === 'ai'
          ? 'Currently: AI-generated'
          : 'Currently: no narrative';
    }

    async function loadDay() {
      const date = dateInput.value;
      if (!date) return;
      loadBtn.disabled = true;
      loadBtn.textContent = 'LOADING…';
      setResult('', false);
      try {
        const card = await apiFetch(`/api/brief?date=${encodeURIComponent(date)}`);
        if (!card.available) {
          textarea.value = '';
          renderBadge(null);
          setResult(card.note || 'No brief exists for that day yet.', true);
          return;
        }
        textarea.value = card.narrative || '';
        renderBadge(card);
        setResult(`Loaded ${date}.`, false);
      } catch (err) {
        setResult(err.message, true);
      } finally {
        loadBtn.disabled = false;
        loadBtn.textContent = 'LOAD';
      }
    }

    loadBtn.addEventListener('click', loadDay);

    saveBtn.addEventListener('click', async () => {
      const date = dateInput.value;
      const narrative = textarea.value.trim();
      if (!date || !narrative) return;

      saveBtn.disabled = true;
      saveBtn.textContent = 'SAVING…';
      setResult('', false);
      try {
        const body = { date, narrative };
        if (noteInput.value.trim()) body.note = noteInput.value.trim();
        const res = await apiFetch('/api/admin/brief', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        renderBadge({ narrative_source: res.narrative_source });
        setResult(`Saved ${res.date}. Marked as manual/Edited.`, false);
      } catch (err) {
        setResult(err.message, true);
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'SAVE';
      }
    });

    loadDay();
  },
};
