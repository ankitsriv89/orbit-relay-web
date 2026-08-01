import { PANELS } from './registry.js';
import { apiFetch } from './api.js';
import { wireHudToggle, expandHud, isMobile, initMobileListener } from '/shared/hud.js';

const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const panelsEl = document.getElementById('admin-panels');
const logoutBtn = document.getElementById('logout-btn');

// Poll timers per panel (refreshMs). Cleared on logout — a dead session must
// not keep hammering the API from hidden panels, and re-login must rebuild.
const panelTimers = new Set();

async function checkAuth() {
  try {
    await apiFetch('/api/admin/health');
    showDashboard();
  } catch {
    showLogin();
  }
}

function showLogin() {
  loginScreen.hidden = false;
  panelsEl.hidden = true;
}

function showDashboard() {
  loginScreen.hidden = true;
  panelsEl.hidden = false;
  buildPanels();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const pw = document.getElementById('login-password').value;
  try {
    await apiFetch('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: pw }),
    });
    showDashboard();
  } catch (err) {
    loginError.textContent = err.message || 'Login failed';
    loginError.hidden = false;
    // A failed attempt must not leave the password in the field — the same
    // terminal is shared with the rest of the page.
    document.getElementById('login-password').value = '';
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/admin/logout', { method: 'POST' });
  } catch (_) {}
  stopPanelTimers();
  built = false;
  panelsEl.replaceChildren();
  document.getElementById('login-password').value = '';
  showLogin();
});

function stopPanelTimers() {
  for (const id of panelTimers) clearInterval(id);
  panelTimers.clear();
}

let built = false;

function buildPanels() {
  if (built) return;
  built = true;

  const sorted = [...PANELS].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  for (const panel of sorted) {
    const hud = document.createElement('div');
    hud.id = `${panel.id}-hud`;
    hud.className = 'orbital-hud key-hud key-hud--collapsed';

    const toggle = document.createElement('button');
    toggle.id = `${panel.id}-toggle`;
    toggle.className = 'key-hud-toggle';
    toggle.textContent = panel.title;
    toggle.setAttribute('aria-expanded', 'false');

    const body = document.createElement('div');
    body.id = `${panel.id}-body`;
    body.className = 'key-hud-body';
    body.hidden = true;

    hud.appendChild(toggle);
    hud.appendChild(body);
    panelsEl.appendChild(hud);

    wireHudToggle(`${panel.id}-hud`, `${panel.id}-toggle`, `${panel.id}-body`, {
      exclusive: 'never',
    });

    // `open` starts the panel expanded on DESKTOP only — on mobile the column
    // accordion stays collapsed so data-heavy panels don't dominate the fold.
    if (panel.open && !isMobile()) {
      expandHud(`${panel.id}-hud`);
    }

    loadPanel(panel, body);
  }

  initMobileListener();
}

async function loadPanel(panel, bodyEl) {
  const run = async () => {
    const data = panel.load ? await panel.load() : null;
    const ctx = { reload: run };
    panel.render(bodyEl, data, ctx);
    return ctx;
  };
  try {
    const ctx = await run();
    if (panel.refreshMs) {
      const timerId = setInterval(async () => {
        try {
          const fresh = panel.load ? await panel.load() : null;
          panel.render(bodyEl, fresh, ctx);
        } catch (err) {
          // A refresh failure renders the error in place; the panel keeps its
          // last good data on the next successful tick.
          bodyEl.replaceChildren();
          const hint = document.createElement('p');
          hint.className = 'admin-hint';
          hint.textContent = `Refresh failed: ${err.message}`;
          bodyEl.appendChild(hint);
        }
      }, panel.refreshMs);
      panelTimers.add(timerId);
    }
  } catch (err) {
    // One panel's failure must not blank the dashboard — render the error
    // inside this panel's body and leave the others alone. The hint stays
    // inside the collapsed body (revealed by the toggle): on mobile the
    // accordion must not be popped open by a failed load.
    bodyEl.replaceChildren();
    const hint = document.createElement('p');
    hint.className = 'admin-hint';
    hint.textContent = `Failed to load: ${err.message}`;
    bodyEl.appendChild(hint);
  }
}

checkAuth();
