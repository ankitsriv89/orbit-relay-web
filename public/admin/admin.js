import { PANELS } from './registry.js';
import { apiFetch } from './api.js';
import { isMobile } from '/shared/hud.js';

const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const pwInput = document.getElementById('login-password');
const pwToggle = document.getElementById('pw-toggle');
const shell = document.getElementById('admin-shell');
const panelsEl = document.getElementById('admin-panels');
const navList = document.getElementById('admin-nav-list');
const logoutBtn = document.getElementById('logout-btn');
const titleEl = document.getElementById('admin-panel-title');
const lastUpdatedEl = document.getElementById('admin-last-updated');
const refreshBtn = document.getElementById('admin-refresh');
const navToggle = document.getElementById('nav-toggle');
const backdrop = document.getElementById('admin-backdrop');
const navStatusEl = document.getElementById('admin-nav-status');
const toastsEl = document.getElementById('admin-toasts');

// One entry per panel: { panel, navEl, dotEl, bodyEl, ctx }.
const entries = new Map();
let ordered = [];
let activeId = null;
let built = false;
let pollTimer = null;
let tickTimer = null;
let refreshToken = 0; // guards the spinner's min-duration timeout against races
const lastUpdated = new Map(); // panelId -> epoch ms
const AUTH_RE = /session|log in again|401|login/i;

function isAuthError(err) {
  return AUTH_RE.test(err?.message || '');
}

function setNavStatus(state, label) {
  navStatusEl.dataset.state = state;
  navStatusEl.textContent = label;
}

function showToast(msg, type = 'info', ms = 4000) {
  const t = document.createElement('div');
  t.className = `admin-toast admin-toast--${type}`;
  t.textContent = msg;
  toastsEl.appendChild(t);
  setTimeout(() => t.classList.add('admin-toast--out'), ms);
  setTimeout(() => t.remove(), ms + 350);
}

/* ── Auth ─────────────────────────────────────────────────────────────────── */

async function checkAuth() {
  try {
    await apiFetch('/api/admin/health');
    showDashboard();
  } catch {
    showLogin();
  }
}

function showLogin() {
  stopPanelTimers();
  shell.hidden = true;
  loginScreen.hidden = false;
  pwInput.focus();
}

function showDashboard() {
  loginScreen.hidden = true;
  shell.hidden = false;
  buildPanels();
  setActive(ordered[0]?.id);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  loginForm.classList.remove('admin-login__form--error');

  const pw = pwInput.value;
  if (!pw) {
    pwInput.focus();
    return;
  }

  loginBtn.disabled = true;
  loginBtn.classList.add('admin-login__btn--loading');
  loginBtn.textContent = 'AUTHENTICATING…';

  try {
    await apiFetch('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: pw }),
    });
    pwInput.value = '';
    showDashboard();
  } catch (err) {
    loginError.textContent = err.message || 'Login failed';
    loginError.hidden = false;
    // Restart the shake animation regardless of prior state.
    loginForm.classList.remove('admin-login__form--error');
    void loginForm.offsetWidth;
    loginForm.classList.add('admin-login__form--error');
    // A failed attempt must not leave the password in the field — the same
    // terminal is shared with the rest of the page.
    pwInput.value = '';
    pwInput.focus();
  } finally {
    loginBtn.disabled = false;
    loginBtn.classList.remove('admin-login__btn--loading');
    loginBtn.textContent = 'AUTHENTICATE';
  }
});

pwToggle.addEventListener('click', () => {
  const show = pwInput.type === 'password';
  pwInput.type = show ? 'text' : 'password';
  pwToggle.setAttribute('aria-pressed', String(show));
  pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  pwInput.focus();
});

logoutBtn.addEventListener('click', async () => {
  try {
    await apiFetch('/api/admin/logout', { method: 'POST' });
  } catch (_) {}
  stopPanelTimers();
  built = false;
  panelsEl.replaceChildren();
  navList.replaceChildren();
  entries.clear();
  ordered = [];
  activeId = null;
  pwInput.value = '';
  showLogin();
});

function handleSessionExpired() {
  stopPanelTimers();
  built = false;
  showToast('Session expired — log in again.', 'error', 6000);
  showLogin();
}

/* ── Timer / polling ──────────────────────────────────────────────────────── */

function stopPanelTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}

// Only the ACTIVE panel polls — hidden panels never hit the API. Switching
// panels tears down the old timer and starts the new one on the spot.
function startPolling(panel) {
  stopPanelTimers();
  if (!panel?.refreshMs || !panel?.load) return;
  pollTimer = setInterval(() => loadActive(false), panel.refreshMs);
}

function startTicker() {
  tickTimer = setInterval(updateLastUpdated, 1000);
}

function updateLastUpdated() {
  const ts = lastUpdated.get(activeId);
  if (!ts) {
    lastUpdatedEl.textContent = '';
    return;
  }
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  lastUpdatedEl.textContent = s < 60 ? `updated ${s}s ago` : `updated ${Math.floor(s / 60)}m ago`;
}

// The spinner stays up at least MIN_MS so even an instant fetch reads as a
// refresh; a token makes a slow request's clear-out harmless after a fast one.
const MIN_REFRESH_MS = 350;
function setRefreshing(on) {
  if (on) {
    refreshBtn.classList.add('is-refreshing');
    refreshBtn.setAttribute('aria-busy', 'true');
  } else {
    const token = ++refreshToken;
    const clear = () => {
      if (token !== refreshToken) return;
      refreshBtn.classList.remove('is-refreshing');
      refreshBtn.setAttribute('aria-busy', 'false');
    };
    const remain = MIN_REFRESH_MS - (Date.now() - refreshStartedAt);
    if (remain > 0) setTimeout(clear, remain);
    else clear();
  }
}

let refreshStartedAt = 0;

async function loadActive(showSpinner = true) {
  const entry = entries.get(activeId);
  if (!entry?.panel?.load) return; // SQL console is interactive, not polled

  if (showSpinner) {
    refreshStartedAt = Date.now();
    setRefreshing(true);
  }
  setNavStatus('load', 'loading');
  try {
    const data = await entry.panel.load();
    const ctx = entry.ctx || (entry.ctx = { reload: () => loadActive(false) });
    entry.panel.render(entry.bodyEl, data, ctx);
    lastUpdated.set(activeId, Date.now());
    updateLastUpdated();
    updateDot(entry, data);
    setNavStatus('ok', 'connected');
  } catch (err) {
    setNavStatus('err', 'error');
    if (isAuthError(err)) {
      setRefreshing(false);
      handleSessionExpired();
      return;
    }
    // A refresh failure is surfaced as a toast; the panel keeps its last
    // good data on the next successful tick.
    showToast(`Refresh failed: ${err.message}`, 'error');
  } finally {
    if (showSpinner) setRefreshing(false);
  }
}

/* ── Sidebar / panel building ─────────────────────────────────────────────── */

function buildPanels() {
  if (built) return;
  built = true;

  ordered = [...PANELS].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  for (const panel of ordered) {
    const li = document.createElement('li');
    li.className = 'admin-nav__item';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-nav__link';
    btn.dataset.panel = panel.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('role', 'option');

    const label = document.createElement('span');
    label.className = 'admin-nav__label';
    label.textContent = panel.title;

    const dot = document.createElement('span');
    dot.className = 'admin-nav__dot';
    dot.setAttribute('aria-hidden', 'true');

    btn.appendChild(label);
    btn.appendChild(dot);
    li.appendChild(btn);
    navList.appendChild(li);

    const body = document.createElement('section');
    body.id = `${panel.id}-body`;
    body.className = 'admin-panel';
    body.hidden = true;
    panelsEl.appendChild(body);

    btn.addEventListener('click', () => {
      setActive(panel.id);
      closeNav(); // mobile: tapping a panel dismisses the drawer
    });

    entries.set(panel.id, { panel, navEl: btn, dotEl: dot, bodyEl: body });
  }

  initNav();
}

function setActive(id) {
  const entry = entries.get(id);
  if (!entry) return;
  activeId = id;

  for (const [pid, e] of entries) {
    e.bodyEl.hidden = pid !== id;
    const active = pid === id;
    e.navEl.classList.toggle('admin-nav__link--active', active);
    e.navEl.setAttribute('aria-pressed', String(active));
  }

  titleEl.textContent = entry.panel.title;
  lastUpdatedEl.textContent = '';
  lastUpdated.delete(id);

  // Panels with a `load` start polling immediately; interactive panels (SQL)
  // are rendered once.
  if (entry.panel.load) {
    loadActive();
    startPolling(entry.panel);
  } else {
    entry.panel.render(entry.bodyEl, null, { reload: () => loadActive(false) });
    startPolling(entry.panel);
  }
  startTicker();
}

function updateDot(entry, data) {
  const badge = entry.panel.badge ? entry.panel.badge(data) : null;
  const state = badge?.state || 'idle';
  const cls = state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'bad' ? 'bad' : '';
  entry.dotEl.className = `admin-nav__dot${cls ? ` admin-nav__dot--${cls}` : ''}`;
  entry.dotEl.title = badge?.label || '';
}

/* ── Mobile drawer ────────────────────────────────────────────────────────── */

function openNav() {
  document.body.setAttribute('data-nav-open', '');
  navToggle.setAttribute('aria-expanded', 'true');
  backdrop.hidden = false;
}

function closeNav() {
  document.body.removeAttribute('data-nav-open');
  navToggle.setAttribute('aria-expanded', 'false');
  backdrop.hidden = true;
}

function toggleNav() {
  if (document.body.hasAttribute('data-nav-open')) closeNav();
  else openNav();
}

function initNav() {
  navToggle.addEventListener('click', toggleNav);
  backdrop.addEventListener('click', closeNav);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.hasAttribute('data-nav-open')) {
      closeNav();
    }
    if (shell.hidden) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'r' || e.key === 'R') loadActive();
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= ordered.length) setActive(ordered[n - 1].id);
  });

  // Desktop resize out of the mobile breakpoint: drop the drawer state.
  window.addEventListener('resize', () => {
    if (!isMobile()) closeNav();
  });
}

refreshBtn.addEventListener('click', () => loadActive());

checkAuth();
