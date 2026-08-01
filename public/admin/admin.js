import { PANELS } from './registry.js';
import { apiFetch } from './api.js';
import { wireHudToggle, initMobileListener } from '/shared/hud.js';

const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const panelsEl = document.getElementById('admin-panels');
const logoutBtn = document.getElementById('logout-btn');

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
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/admin/logout', { method: 'POST' });
  } catch (_) {}
  showLogin();
});

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

    loadPanel(panel, body);
  }

  initMobileListener();
}

async function loadPanel(panel, bodyEl) {
  try {
    const data = panel.load ? await panel.load() : null;
    const ctx = {
      reload: () => loadPanel(panel, bodyEl),
    };
    panel.render(bodyEl, data, ctx);
    if (panel.refreshMs) {
      setInterval(async () => {
        try {
          const fresh = panel.load ? await panel.load() : null;
          panel.render(bodyEl, fresh, ctx);
        } catch (_) {}
      }, panel.refreshMs);
    }
  } catch (err) {
    bodyEl.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'admin-hint';
    hint.textContent = `Failed to load: ${err.message}`;
    bodyEl.appendChild(hint);
    bodyEl.hidden = false;
  }
}

initMobileListener();
checkAuth();
