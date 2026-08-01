try {
  if (!navigator.webdriver) {
    const body = JSON.stringify({
      path: location.pathname,
      ref: document.referrer ? new URL(document.referrer).origin : '',
    });
    if (navigator.sendBeacon) navigator.sendBeacon('/api/hit', new Blob([body], { type: 'application/json' }));
    else fetch('/api/hit', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
  }
} catch (_) { /* analytics must never break a page */ }
