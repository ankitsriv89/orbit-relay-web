/**
 * Shared HUD (collapsible panel) and mobile-nav logic, used by every page
 * that has the `.key-hud` panel pattern: /orbit/, /starlink/ and all of
 * /spacetrack/.
 *
 * Provides:
 *  - Collapsible HUD panels, optionally single-expanded via `exclusive`
 *  - Hamburger menu toggle (navigable sections)
 *  - Tab switching within HUD bodies
 *  - Mobile breakpoint awareness
 *
 * `exclusive` controls when opening one panel collapses the others:
 *  - 'mobile' (default): only on narrow screens, where panels would overlap.
 *    This is /orbit/'s original behavior — desktop has room for several
 *    panels open at once.
 *  - 'always': every panel toggle collapses the rest, regardless of width.
 *  - 'never': opening a panel never collapses another. Correct for /admin/,
 *    where panels are a scrolling column and cannot overlap — an accordion
 *    there would only hide data.
 */

import { State } from '/spacetrack/shared/state.js';

const MOBILE_MQ = window.matchMedia('(max-width: 768px)');
export const isMobile = () => MOBILE_MQ.matches;

let _hudPanels = [];

function collapsePanel(p) {
    p.classList.add('key-hud--collapsed');
    const b = p.querySelector('.key-hud-body');
    const t = p.querySelector('.key-hud-toggle');
    if (b) b.hidden = true;
    if (t) t.setAttribute('aria-expanded', 'false');
}

export function expandHud(hudId) {
    const hud = document.getElementById(hudId);
    if (!hud) return;
    hud.classList.remove('key-hud--collapsed');
    const body = hud.querySelector('.key-hud-body');
    const toggle = hud.querySelector('.key-hud-toggle');
    if (body) body.hidden = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
}

export function collapseHud(hudId) {
    const hud = document.getElementById(hudId);
    if (!hud) return;
    collapsePanel(hud);
}

export function wireHudToggle(hudId, toggleId, bodyId, { exclusive = 'mobile' } = {}) {
    const hud = document.getElementById(hudId);
    const toggle = document.getElementById(toggleId);
    const body = document.getElementById(bodyId);
    if (!hud || !toggle || !body) return;
    _hudPanels.push(hud);
    toggle.addEventListener('click', () => {
        const willExpand = hud.classList.contains('key-hud--collapsed');
        // On narrow screens (or always, if asked) keep only one panel
        // expanded so cards don't overlap.
        if (willExpand && (exclusive === 'always' || (exclusive === 'mobile' && isMobile()))) {
            _hudPanels.forEach(p => { if (p !== hud) collapsePanel(p); });
        }
        const collapsed = hud.classList.toggle('key-hud--collapsed');
        body.hidden = collapsed;
        toggle.setAttribute('aria-expanded', String(!collapsed));
        document.body.classList.toggle('hud-panel-open', !collapsed && isMobile());
    });
}

export function initMobileListener(onChange) {
    MOBILE_MQ.addEventListener('change', () => {
        if (!isMobile()) {
            document.body.classList.remove('hud-panel-open');
        } else {
            const open = _hudPanels.filter(p => !p.classList.contains('key-hud--collapsed'));
            open.slice(1).forEach(collapsePanel);
            document.body.classList.toggle('hud-panel-open', open.length > 0);
        }
        if (onChange) onChange();
    });
}

function closeMobileMenu() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const mobileMenu = document.getElementById('mobile-menu');
    if (!hamburgerBtn || !mobileMenu) return;
    mobileMenu.hidden = true;
    hamburgerBtn.classList.remove('hamburger--open');
    hamburgerBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('mobile-menu-open');
}

export function initHamburgerMenu() {
    const hamburgerBtn = document.getElementById('hamburger-btn');
    const mobileMenu = document.getElementById('mobile-menu');
    if (!hamburgerBtn || !mobileMenu) return;

    hamburgerBtn.addEventListener('click', () => {
        const open = mobileMenu.hidden;
        if (open) {
            mobileMenu.hidden = false;
            hamburgerBtn.classList.add('hamburger--open');
            hamburgerBtn.setAttribute('aria-expanded', 'true');
            document.body.classList.add('mobile-menu-open');
        } else {
            closeMobileMenu();
        }
    });

    /* Close on outside-click (tap the backdrop) */
    mobileMenu.addEventListener('click', (e) => {
        if (e.target === mobileMenu) closeMobileMenu();
    });

    /* Close on Escape key */
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !mobileMenu.hidden) closeMobileMenu();
    });

    /* Close when a link is tapped */
    mobileMenu.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', closeMobileMenu);
    });

    /* Close button */
    const closeBtn = document.getElementById('mobile-menu-close');
    if (closeBtn) closeBtn.addEventListener('click', closeMobileMenu);
}

export function wireTabs(container) {
    if (!container) return;
    const tabs = container.querySelectorAll('.menu-tab');
    const sections = container.querySelectorAll('.menu-section');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.dataset.tab;
            tabs.forEach(t => {
                const active = t.dataset.tab === tabId;
                t.classList.toggle('menu-tab--active', active);
                t.setAttribute('aria-selected', String(active));
            });
            sections.forEach(s => {
                s.classList.toggle('menu-section--active', s.dataset.tabContent === tabId);
            });
        });
    });
}

export function closeAllHuds() {
    _hudPanels.forEach(collapsePanel);
    document.body.classList.remove('hud-panel-open');
}

/* ── Filter drawer (mobile slide-out) ──────────────────────────────────────
 * The filter drawer is a right-side overlay panel used on mobile (<768px)
 * to replace the fixed-position #filters-hud which is hidden on mobile.
 * Only the catalog page has this element. */

let _drawerOpen = false;

function closeFilterDrawer() {
    const overlay = document.getElementById('filter-drawer-overlay');
    if (!overlay) return;
    overlay.removeAttribute('open');
    _drawerOpen = false;
    document.body.classList.remove('filter-drawer-open');
}

export function openFilterDrawer() {
    const overlay = document.getElementById('filter-drawer-overlay');
    if (!overlay) return;
    overlay.setAttribute('open', '');
    _drawerOpen = true;
    document.body.classList.add('filter-drawer-open');
}

export function toggleFilterDrawer() {
    if (_drawerOpen) closeFilterDrawer();
    else openFilterDrawer();
}

export function initFilterDrawer() {
    const overlay = document.getElementById('filter-drawer-overlay');
    const closeBtn = document.getElementById('filter-drawer-close');
    const openBtn = document.getElementById('filter-drawer-btn');

    if (openBtn) {
        openBtn.addEventListener('click', toggleFilterDrawer);
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closeFilterDrawer);
    }

    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeFilterDrawer();
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _drawerOpen) closeFilterDrawer();
    });
}

/* ── Orbital revolution count (trajectory multi-rev, plan 35 §3) ──────────────
 * A cycle button that extends the inspected orbit ring to N revolutions
 * (plus a fixed half-rev past arc). The desired count is a State
 * `trajectory.revs` preference (default 1), shared across every spacetrack
 * route. Buttons declare either `data-revs=N` (a discrete preset, active
 * state synced) or `data-revs-label` (a single cycle button whose text shows
 * the current value).
 *
 * These are shared/hud.js exports (not spacetrack-internal) because every
 * route that draws `addInspectVisuals` — /orbit/, /starlink/ and all four
 * spacetrack pages — needs the same button semantics. */

export const REVS_OPTIONS = [1, 3, 5];
export const REVS_STATE_PATH = 'trajectory.revs';

export function normalizeRevsCount(revs) {
    const n = Number(revs);
    return REVS_OPTIONS.includes(n) ? n : REVS_OPTIONS[0];
}

export function currentRevs() {
    return normalizeRevsCount(State.get(REVS_STATE_PATH));
}

export function revsLabel(revs) {
    return `REV ${normalizeRevsCount(revs)}×`;
}

export function setRevs(revs) {
    const next = normalizeRevsCount(revs);
    State.set(REVS_STATE_PATH, next);
    syncRevsButtons(next);
    return next;
}

export function cycleRevs() {
    return setRevs(REVS_OPTIONS[(REVS_OPTIONS.indexOf(currentRevs()) + 1) % REVS_OPTIONS.length]);
}

export function syncRevsButtons(revs, root = document) {
    const n = normalizeRevsCount(revs);
    root.querySelectorAll('[data-revs]').forEach(btn => {
        const active = Number(btn.dataset.revs) === n;
        btn.classList.toggle('st-toggle-btn--on', active);
        btn.setAttribute('aria-pressed', String(active));
    });
    root.querySelectorAll('[data-revs-label]').forEach(el => { el.textContent = revsLabel(n); });
    return n;
}

export function wireRevsButton(button, { onChange } = {}) {
    if (!button) return;
    button.addEventListener('click', () => {
        const preset = button.dataset.revs;
        const next = preset != null ? setRevs(Number(preset)) : cycleRevs();
        if (onChange) onChange(next);
    });
}
