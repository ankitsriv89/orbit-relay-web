/**
 * Unified `window.__spacetrack` debug handle.
 *
 * Plan 34 wave 2.2. Each page used to assign `window.__spacetrack` its own
 * incompatible shape — five modules, five fresh object literals with their own
 * getters. They never collided (one document per page), but nothing enforced a
 * shared core, and a new page had to reverse-engineer the pattern by reading
 * one of the existing ones. The tests/e2e suites lean on this handle
 * (`engine`, `render`, `renderBrief`, `screener`, …), so the per-page members
 * are the contract; only the wiring is now shared.
 *
 * `exposeDebug(page, api)` installs the handle and returns it. `source` names
 * the page on every handle; everything in `api` is copied onto it by property
 * descriptor, so live getters stay live (a plain object spread would evaluate
 * them once at install time and ship stale snapshots).
 */
export function exposeDebug(page, api) {
    const handle = {};
    Object.defineProperty(handle, 'source', { get: () => page, enumerable: true });
    Object.defineProperties(handle, Object.getOwnPropertyDescriptors(api));
    window.__spacetrack = handle;
    return handle;
}
