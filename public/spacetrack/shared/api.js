const STORAGE_KEY = 'spacetrack_api_base';

let API_BASE = (() => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) return stored;
    } catch (_) {}
    const params = new URLSearchParams(window.location.search);
    const urlParam = params.get('api');
    if (urlParam) {
        try { localStorage.setItem(STORAGE_KEY, urlParam); } catch (_) {}
        return urlParam;
    }
    return '/api';
})();

export function setApiBase(base) {
    API_BASE = base;
    try { localStorage.setItem(STORAGE_KEY, base); } catch (_) {}
}

export function getApiBase() { return API_BASE; }

async function fetchJSON(url, options = {}) {
    const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!response.ok) {
        throw new Error(`${url} ${response.status}`);
    }
    return response.json();
}

export const API = {
    async search(params) {
        const url = new URL(`${API_BASE}/search`);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== '' && v != null) url.searchParams.set(k, v);
        });
        return fetchJSON(url);
    },

    async summary() {
        return fetchJSON(`${API_BASE}/summary`);
    },

    async facets() {
        return fetchJSON(`${API_BASE}/search?facets=1`);
    },

    async object(norad) {
        return fetchJSON(`${API_BASE}/object/${norad}`);
    },

    async feed(limit = 30) {
        return fetchJSON(`${API_BASE}/feed?limit=${limit}`);
    },

    async decayWatch(limit = 20) {
        return fetchJSON(`${API_BASE}/decay-watch?limit=${limit}`);
    },

    async boxscore() {
        return fetchJSON(`${API_BASE}/boxscore`);
    },

    async brief() {
        return fetchJSON(`${API_BASE}/brief`);
    },

    async analytics() {
        return fetchJSON(`${API_BASE}/analytics`);
    },
};
