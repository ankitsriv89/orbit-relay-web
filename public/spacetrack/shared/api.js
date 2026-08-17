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
        /* The API answers a rejected filter with {"error": "Unknown era. Use one
           of: …"} — a message worth showing. Fall back to the status when the
           body is empty or not JSON (a gateway error page, say). */
        let detail = '';
        try {
            const body = await response.json();
            if (body && typeof body.error === 'string') detail = body.error;
        } catch (_) {}
        const err = new Error(detail || `${url} ${response.status}`);
        err.status = response.status;
        err.detail = detail;
        throw err;
    }
    return response.json();
}

export const API = {
    async search(params) {
        /* Build the query with URLSearchParams, not `new URL(…, location.origin)`:
           on a file:// page `origin` is the string "null" and the URL constructor
           throws "Invalid URL". fetch() resolves a relative path on its own, which
           is what every other method here already relies on. */
        const qs = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => {
            if (v !== '' && v != null) qs.set(k, v);
        });
        const query = qs.toString();
        return fetchJSON(`${API_BASE}/search${query ? `?${query}` : ''}`);
    },

    async summary() {
        return fetchJSON(`${API_BASE}/summary`);
    },

    async facets(params = {}) {
        const qs = new URLSearchParams({ facets: '1' });
        Object.entries(params).forEach(([k, v]) => {
            if (v !== '' && v != null) qs.set(k, v);
        });
        return fetchJSON(`${API_BASE}/search?${qs.toString()}`);
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

    async brief(date) {
        return fetchJSON(`${API_BASE}/brief${date ? `?date=${date}` : ''}`);
    },

    async briefIndex() {
        return fetchJSON(`${API_BASE}/brief?index`);
    },

    async analytics() {
        return fetchJSON(`${API_BASE}/analytics`);
    },
};
