/**
 * Floating feedback widget — mounted the same way as /js/beacon.js (one
 * <script type="module"> tag per page), so it needs zero page-specific
 * wiring and no dependency on tokens.css being linked (some pages don't).
 * Styles and markup are both self-injected.
 *
 * Posts to POST /api/feedback. Fire-and-forget from the user's point of
 * view — a failed submit shows an inline error and leaves the form filled
 * in so nothing typed is lost.
 */

const STYLE = `
.fb-tab {
    position: fixed;
    bottom: calc(24px + env(safe-area-inset-bottom, 0px));
    right: calc(16px + env(safe-area-inset-right, 0px));
    z-index: 40;
    font-family: "SFMono-Regular", "JetBrains Mono", "Roboto Mono", "Courier New", monospace;
}
@media (max-width: 768px) {
    /* Lift above .mobile-bottom-nav (chrome.css) — 56px + safe-area, plus a
       gap — so the tab doesn't sit on top of the bottom nav's tap targets. */
    .fb-tab {
        bottom: calc(56px + env(safe-area-inset-bottom, 0px) + 12px);
    }
}
.fb-tab__btn {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    min-height: 44px;
    font-family: inherit;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 1.5px;
    color: #e8f4fa;
    background: rgba(6, 14, 24, 0.88);
    border: 1px solid rgba(0, 210, 255, 0.35);
    border-radius: 999px;
    backdrop-filter: blur(8px);
    cursor: pointer;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
}
.fb-tab__btn:hover { border-color: rgba(0, 210, 255, 0.7); color: #00d2ff; }
.fb-panel {
    position: absolute;
    bottom: calc(100% + 10px);
    right: 0;
    width: min(320px, calc(100vw - 32px));
    padding: 14px;
    background: rgba(6, 14, 24, 0.96);
    border: 1px solid rgba(0, 210, 255, 0.28);
    border-radius: 10px;
    backdrop-filter: blur(12px);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
    color: #e8f4fa;
}
.fb-panel[hidden] { display: none; }
.fb-panel__title {
    margin: 0 0 10px;
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 1.5px;
    color: #00d2ff;
}
.fb-panel__kinds {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
}
.fb-kind {
    flex: 1;
    padding: 8px 4px;
    min-height: 36px;
    font-family: inherit;
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.5px;
    color: #7d94a3;
    background: rgba(0, 210, 255, 0.06);
    border: 1px solid rgba(0, 210, 255, 0.16);
    border-radius: 5px;
    cursor: pointer;
}
.fb-kind[aria-pressed="true"] {
    color: #050810;
    background: #00d2ff;
    border-color: #00d2ff;
}
.fb-panel textarea,
.fb-panel input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    margin-bottom: 8px;
    font-family: inherit;
    font-size: 0.7rem;
    color: #e8f4fa;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(0, 210, 255, 0.2);
    border-radius: 5px;
    outline: none;
    resize: vertical;
}
.fb-panel textarea { min-height: 70px; }
.fb-panel textarea:focus,
.fb-panel input:focus { border-color: #00d2ff; }
.fb-panel__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}
.fb-panel__submit {
    padding: 8px 16px;
    min-height: 40px;
    font-family: inherit;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 1px;
    color: #050810;
    background: #00d2ff;
    border: none;
    border-radius: 5px;
    cursor: pointer;
}
.fb-panel__submit:disabled { opacity: 0.4; cursor: not-allowed; }
.fb-panel__status {
    flex: 1;
    font-size: 0.6rem;
    color: #7d94a3;
    font-style: italic;
}
.fb-panel__status[data-tone="error"] { color: #ff8c5a; }
.fb-panel__status[data-tone="ok"] { color: #00d2ff; }
@media (prefers-reduced-motion: no-preference) {
    .fb-panel { transition: opacity 0.15s ease, transform 0.15s ease; }
}
`;

const KINDS = [
    { id: 'bug', label: 'BUG' },
    { id: 'suggestion', label: 'IDEA' },
    { id: 'feedback', label: 'OTHER' },
];

function mount() {
    if (document.getElementById('fb-tab')) return;

    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'fb-tab';
    root.id = 'fb-tab';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fb-tab__btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'fb-panel');
    btn.textContent = '✉ FEEDBACK';

    const panel = document.createElement('div');
    panel.className = 'fb-panel';
    panel.id = 'fb-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Send feedback');

    const title = document.createElement('p');
    title.className = 'fb-panel__title';
    title.textContent = '// REPORT A BUG OR SUGGESTION';
    panel.appendChild(title);

    const kindsRow = document.createElement('div');
    kindsRow.className = 'fb-panel__kinds';
    let selectedKind = 'bug';
    const kindBtns = [];
    for (const k of KINDS) {
        const kb = document.createElement('button');
        kb.type = 'button';
        kb.className = 'fb-kind';
        kb.textContent = k.label;
        kb.setAttribute('aria-pressed', String(k.id === selectedKind));
        kb.addEventListener('click', () => {
            selectedKind = k.id;
            for (const b of kindBtns) b.setAttribute('aria-pressed', String(b === kb));
        });
        kindBtns.push(kb);
        kindsRow.appendChild(kb);
    }
    panel.appendChild(kindsRow);

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'What happened, or what would help?';
    textarea.maxLength = 2000;
    panel.appendChild(textarea);

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.placeholder = 'Email (optional — for a reply)';
    panel.appendChild(emailInput);

    const row = document.createElement('div');
    row.className = 'fb-panel__row';

    const status = document.createElement('span');
    status.className = 'fb-panel__status';

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'fb-panel__submit';
    submit.textContent = 'SEND';

    row.appendChild(status);
    row.appendChild(submit);
    panel.appendChild(row);

    root.appendChild(panel);
    root.appendChild(btn);
    document.body.appendChild(root);

    function togglePanel(open) {
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        if (open) textarea.focus();
    }

    btn.addEventListener('click', () => togglePanel(panel.hidden));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.hidden) togglePanel(false);
    });
    document.addEventListener('click', (e) => {
        if (!panel.hidden && !root.contains(e.target)) togglePanel(false);
    });

    submit.addEventListener('click', async () => {
        const message = textarea.value.trim();
        if (!message) {
            status.textContent = 'Say a little more first.';
            status.dataset.tone = 'error';
            textarea.focus();
            return;
        }

        submit.disabled = true;
        status.textContent = 'Sending…';
        status.dataset.tone = '';

        try {
            const res = await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kind: selectedKind,
                    message,
                    email: emailInput.value.trim(),
                    path: location.pathname,
                }),
            });
            if (!res.ok) throw new Error();

            status.textContent = 'Thanks — sent.';
            status.dataset.tone = 'ok';
            textarea.value = '';
            emailInput.value = '';
            setTimeout(() => togglePanel(false), 1200);
        } catch (_) {
            status.textContent = 'Send failed — try again.';
            status.dataset.tone = 'error';
        } finally {
            submit.disabled = false;
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
