/**
 * Two-way mirroring for a pair of checkboxes that represent the same control
 * rendered twice — the desktop panel copy and the mobile filter-drawer copy.
 *
 * Why this is not a two-line `addEventListener` each way:
 *
 * Both copies carry their OWN real listener (the layer-toggle handler bound to
 * every `.layer-cb`), and assigning `.checked` in script does NOT fire `change`.
 * So the mirror must be told explicitly — hence the synthetic `change` dispatch.
 * But a handler that dispatches unconditionally re-enters its partner, which
 * dispatches back, forever: one click on a layer checkbox took down the whole
 * page with `RangeError: Maximum call stack size exceeded`.
 *
 * The guard is the `checked` value itself. By the time the synthetic event
 * reaches the partner, the two are already equal, so the partner returns
 * without dispatching and the cascade stops after exactly one hop. Each side's
 * real listener still runs exactly once.
 *
 * Do not "simplify" this by dropping the equality check or the dispatch —
 * removing the check restores the infinite recursion, and removing the dispatch
 * silently stops the mirrored copy from applying its layer change.
 */

/**
 * Mirror `checked` between two checkboxes, in both directions.
 *
 * @param {{checked: boolean, addEventListener: Function, dispatchEvent: Function}} a
 * @param {{checked: boolean, addEventListener: Function, dispatchEvent: Function}} b
 * @param {{makeEvent?: () => any}} [opts] `makeEvent` builds the synthetic
 *        event; overridable so this is testable outside a browser.
 */
export function syncCheckboxes(a, b, opts = {}) {
    if (!a || !b) return;
    const makeEvent = opts.makeEvent
        || (() => new Event('change', { bubbles: true }));

    const link = (from, to) => {
        from.addEventListener('change', () => {
            // Already in sync — this is the echo of our own mirrored write.
            // Returning here is what stops the mutual recursion.
            if (to.checked === from.checked) return;
            to.checked = from.checked;
            to.dispatchEvent(makeEvent());
        });
    };

    link(a, b);
    link(b, a);
}
