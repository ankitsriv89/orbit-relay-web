/**
 * Shared UI Components
 * Collapsible panels, dropdown menus, time warp controls, footer
 */

import { State } from './state.js';

function createCollapsiblePanel(options) {
    const {
        id,
        title,
        position = 'top-left',
        collapsed = true,
        children = [],
        className = '',
    } = options;

    const panel = document.createElement('div');
    panel.id = id;
    panel.className = `orbital-hud key-hud ${className} ${collapsed ? 'key-hud--collapsed' : ''}`;
    panel.style.cssText = getPositionCSS(position);

    const toggle = document.createElement('button');
    toggle.className = 'key-hud-toggle';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-controls', `${id}-body`);
    toggle.innerHTML = `
        <span class="key-hud-toggle-arrow">▶</span>
        <span class="hud-title hud-title--bare">${title}</span>
    `;

    const body = document.createElement('div');
    body.id = `${id}-body`;
    body.className = 'key-hud-body';
    body.hidden = collapsed;

    children.forEach(child => {
        if (typeof child === 'string') {
            body.insertAdjacentHTML('beforeend', child);
        } else if (child instanceof Node) {
            body.appendChild(child);
        }
    });

    panel.appendChild(toggle);
    panel.appendChild(body);

    toggle.addEventListener('click', () => {
        const isCollapsed = panel.classList.toggle('key-hud--collapsed');
        body.hidden = isCollapsed;
        toggle.setAttribute('aria-expanded', String(!isCollapsed));
        document.body.classList.toggle('hud-panel-open', !isCollapsed);
    });

    return panel;
}

function getPositionCSS(position) {
    const positions = {
        'top-left': 'top: calc(90px + var(--sa-top)); left: calc(24px + var(--sa-left));',
        'top-right': 'top: calc(90px + var(--sa-top)); right: calc(24px + var(--sa-right));',
        'bottom-left': 'bottom: calc(74px + var(--sa-bottom)); left: calc(16px + var(--sa-left));',
        'bottom-right': 'bottom: calc(74px + var(--sa-bottom)); right: calc(16px + var(--sa-right));',
    };
    return positions[position] || positions['top-left'];
}

function createDropdownMenu(options) {
    const { id, tabs = [], defaultTab = tabs[0]?.id } = options;

    const container = document.createElement('div');
    container.id = id;
    container.className = 'menu-dropdown';
    container.hidden = true;

    const header = document.createElement('div');
    header.className = 'menu-header';

    const tablist = document.createElement('nav');
    tablist.className = 'menu-tabs';
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Panel sections');

    tabs.forEach((tab, index) => {
        const btn = document.createElement('button');
        btn.className = `menu-tab ${index === 0 ? 'menu-tab--active' : ''}`;
        btn.dataset.tab = tab.id;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(index === 0));
        btn.setAttribute('aria-controls', `${id}-${tab.id}`);
        btn.textContent = tab.label;
        btn.addEventListener('click', () => switchTab(container, tab.id));
        tablist.appendChild(btn);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'menu-close';
    closeBtn.setAttribute('aria-label', 'Close menu');
    closeBtn.innerHTML = '✕';
    closeBtn.addEventListener('click', () => closeDropdown(container));

    header.appendChild(tablist);
    header.appendChild(closeBtn);

    const sections = document.createElement('div');
    sections.className = 'menu-sections';

    tabs.forEach((tab, index) => {
        const section = document.createElement('div');
        section.id = `${id}-${tab.id}`;
        section.className = `menu-section ${index === 0 ? 'menu-section--active' : ''}`;
        section.dataset.tabContent = tab.id;
        section.setAttribute('role', 'tabpanel');
        section.setAttribute('aria-labelledby', `${id}-tab-${tab.id}`);
        if (tab.content) {
            if (typeof tab.content === 'string') {
                section.innerHTML = tab.content;
            } else {
                section.appendChild(tab.content);
            }
        }
        sections.appendChild(section);
    });

    container.appendChild(header);
    container.appendChild(sections);

    return container;
}

function switchTab(container, tabId) {
    container.querySelectorAll('.menu-tab').forEach(btn => {
        const active = btn.dataset.tab === tabId;
        btn.classList.toggle('menu-tab--active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    container.querySelectorAll('.menu-section').forEach(section => {
        section.classList.toggle('menu-section--active', section.dataset.tabContent === tabId);
    });
}

function openDropdown(container) {
    container.hidden = false;
    document.body.classList.add('hud-panel-open');
}

function closeDropdown(container) {
    container.hidden = true;
    document.body.classList.remove('hud-panel-open');
}

function createTimeWarpControls() {
    const container = document.createElement('div');
    container.className = 'orbital-hud time-warp';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Time warp controls');
    container.innerHTML = `
        <span class="tw-label">⏱ TIME</span>
        <div class="tw-btns">
            <button class="tw-btn" data-rate="0" title="Pause">❚❚</button>
            <button class="tw-btn tw-btn--active" data-rate="1" title="Real time">1×</button>
            <button class="tw-btn" data-rate="60" title="60× speed">60×</button>
            <button class="tw-btn" data-rate="600" title="600× speed">600×</button>
        </div>
    `;
    return container;
}

function createFooter() {
    const footer = document.createElement('footer');
    footer.className = 'orbital-footer';
    footer.innerHTML = `
        <span id="footer-source">Live data: Space-Track</span>
        <span class="orbital-footer__cite">Orbital data courtesy of Space-Track.org (USSPACECOM / 18th Space Defense Squadron)</span>
        <span>rendered with CesiumJS</span>
    `;
    return footer;
}

export const UI = {
    createCollapsiblePanel,
    createDropdownMenu,
    createTimeWarpControls,
    createFooter,
    openDropdown,
    closeDropdown,
};