/**
 * Shared Navigation Component
 * Top-level navigation bar for SpaceTrack multi-page app
 */

const NAV_ITEMS = [
    { id: 'catalog', label: 'CATALOG', href: '/spacetrack/' },
    { id: 'signal', label: 'SIGNAL', href: '/spacetrack/signal/' },
    { id: 'conjunctions', label: 'CONJUNCTIONS', href: '/spacetrack/conjunctions/' },
    { id: 'brief', label: 'BRIEF', href: '/spacetrack/brief/' },
    { id: 'analytics', label: 'ANALYTICS', href: '/spacetrack/analytics/' },
];

function getCurrentPage() {
    const path = window.location.pathname;
    if (path.endsWith('/spacetrack/') || path.endsWith('/spacetrack/index.html')) return 'catalog';
    if (path.endsWith('/spacetrack/signal/') || path.endsWith('/spacetrack/signal/index.html')) return 'signal';
    if (path.endsWith('/spacetrack/conjunctions/') || path.endsWith('/spacetrack/conjunctions/index.html')) return 'conjunctions';
    if (path.endsWith('/spacetrack/brief/') || path.endsWith('/spacetrack/brief/index.html')) return 'brief';
    if (path.endsWith('/spacetrack/analytics/') || path.endsWith('/spacetrack/analytics/index.html')) return 'analytics';
    return 'catalog';
}

function createNavigation() {
    const currentPage = getCurrentPage();
    const nav = document.createElement('nav');
    nav.className = 'spacetrack-nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'SpaceTrack main navigation');

    const brand = document.createElement('a');
    brand.className = 'spacetrack-nav__brand';
    brand.href = '/spacetrack/';
    brand.textContent = '◂ SPACETRACK';
    nav.appendChild(brand);

    const list = document.createElement('ul');
    list.className = 'spacetrack-nav__list';
    list.setAttribute('role', 'menubar');

    NAV_ITEMS.forEach(item => {
        const li = document.createElement('li');
        li.setAttribute('role', 'none');

        const a = document.createElement('a');
        a.className = 'spacetrack-nav__link';
        a.href = item.href;
        a.textContent = item.label;
        a.setAttribute('role', 'menuitem');
        if (item.id === currentPage) {
            a.classList.add('spacetrack-nav__link--active');
            a.setAttribute('aria-current', 'page');
        }
        li.appendChild(a);
        list.appendChild(li);
    });

    nav.appendChild(list);

    const status = document.createElement('div');
    status.className = 'spacetrack-nav__status';
    status.setAttribute('aria-live', 'polite');
    nav.appendChild(status);

    return nav;
}

function initNavigation(containerSelector = '.spacetrack-nav-container') {
    const container = document.querySelector(containerSelector);
    if (!container) {
        console.warn('[Navigation] Container not found:', containerSelector);
        return;
    }
    container.appendChild(createNavigation());
}

function updateNavStatus(message) {
    const status = document.querySelector('.spacetrack-nav__status');
    if (status) status.textContent = message;
}

function setActiveNav(pageId) {
    document.querySelectorAll('.spacetrack-nav__link').forEach(link => {
        const isActive = link.getAttribute('href')?.includes(pageId) ||
                        (pageId === 'catalog' && link.getAttribute('href') === '/spacetrack/');
        link.classList.toggle('spacetrack-nav__link--active', isActive);
        link.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
}

export const Navigation = {
    create: createNavigation,
    init: initNavigation,
    updateStatus: updateNavStatus,
    setActive: setActiveNav,
    getCurrentPage,
    items: NAV_ITEMS,
};