/**
 * Shared State Management for SpaceTrack Multi-Page App
 * Persists selected object, filters, time controls, and preferences across pages.
 */

const STORAGE_KEY = 'spacetrack_state_v1';
const EVENT_PREFIX = 'spacetrack:';

const defaultState = {
    selectedObject: null,
    filters: {
        q: '',
        type: '',
        country: '',
        regime: '',
        era: '',
        operator: '',
    },
    time: {
        rate: 1,
        paused: false,
    },
    camera: {
        position: null,
    },
    preferences: {
        theme: 'dark',
        units: 'metric',
        colorMode: 'type',   // 'type' or 'country'
    },
    trajectory: {
        revs: 1,   // orbital revolutions shown for past + future path arcs
    },
};

let state = { ...defaultState };
let listeners = new Map();

function load() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            state = deepMerge(defaultState, parsed);
        }
    } catch (e) {
        console.warn('[spacetrack] Failed to load state:', e);
    }
    return state;
}

function save() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
        console.warn('[spacetrack] Failed to save state:', e);
    }
}

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            result[key] = deepMerge(target[key] || {}, source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

function get(path) {
    const keys = path.split('.');
    let value = state;
    for (const key of keys) {
        if (value == null) return undefined;
        value = value[key];
    }
    return value;
}

function set(path, value) {
    const keys = path.split('.');
    let obj = state;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!obj[keys[i]] || typeof obj[keys[i]] !== 'object') {
            obj[keys[i]] = {};
        }
        obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    save();
    emit(path, value);
    emit('*', { path, value, state: { ...state } });
}

function subscribe(path, callback) {
    if (!listeners.has(path)) listeners.set(path, new Set());
    listeners.get(path).add(callback);
    return () => {
        const set = listeners.get(path);
        if (set) set.delete(callback);
    };
}

function emit(path, value) {
    const set = listeners.get(path);
    if (set) set.forEach(cb => cb(value, state));
    window.dispatchEvent(new CustomEvent(`${EVENT_PREFIX}${path}`, { detail: { value, state } }));
}

function reset() {
    state = { ...defaultState };
    save();
    emit('*', { state: { ...state } });
}

load();

export const State = {
    get,
    set,
    subscribe,
    getAll: () => ({ ...state }),
    reset,
    load,
    save,
    on: subscribe,
    off: (path, callback) => {
        const set = listeners.get(path);
        if (set) set.delete(callback);
    },
};