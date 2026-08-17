/**
 * Pass notification scheduler — wraps the browser Notification API.
 * Permission is requested only on explicit user action (the toggle click),
 * never auto-prompted on page load.
 *
 * On permission grant, schedules a setTimeout for each upcoming pass's AOS
 * time from predictPasses's existing output. Cap the schedule to the passes
 * already computed and visible in the panel — no new computation, just a
 * timer over the existing numbers.
 *
 * Timers clear on object deselection and on beforeunload.
 *
 * Notification body: object name, AOS time, max elevation — the same fields
 * the pass list already renders, reused, not derived fresh.
 */

let notificationPermission = 'default';
let notificationTimeouts = [];
let pendingObjectName = '';

function setPermissionState(result) {
    notificationPermission = result;
}

function requestPermission() {
    if (typeof window.Notification === 'undefined') {
        setPermissionState('unsupported');
        return Promise.resolve('unsupported');
    }
    return window.Notification.requestPermission().then(setPermissionState);
}

function clearAllNotifications() {
    notificationTimeouts.forEach(t => clearTimeout(t));
    notificationTimeouts = [];
    try { window.Notification.clearAll(); } catch (_) {}
}

function scheduleNotifications(passes, objectName) {
    clearAllNotifications();
    pendingObjectName = objectName;

    for (const p of passes) {
        const delay = p.start - Date.now();
        // Only schedule if the pass is within the next 24h and in the future
        if (delay > 0 && delay < 86400000) {
            const timeout = setTimeout(() => {
                try {
                    if (Notification.permission === 'granted') {
                        const fmt = (d) => {
                            const s = d.toUTCString();
                            return s.slice(5, 7) + '/' + s.slice(8, 10) + ' ' + s.slice(17, 25);
                        };
                        new window.Notification(
                            `${objectName}`,
                            {
                                body: `AOS: ${fmt(p.start)} — max elev: ${p.maxElev.toFixed(1)}°`,
                            }
                        );
                    }
                } catch (_) {}
            }, delay);
            notificationTimeouts.push(timeout);
        }
    }
}

function clearNotifications() {
    clearAllNotifications();
    pendingObjectName = '';
    // Notify caller to update UI - the toggle should appear "off" when permission is denied
    // The caller checks Notification.permission to determine the state
    return notificationPermission;
}

export { requestPermission, scheduleNotifications, clearNotifications };