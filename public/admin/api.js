const STATUS_MESSAGES = {
  400: 'The request was rejected (bad input)',
  401: 'Session expired or missing — log in again.',
  403: 'Access denied.',
  404: 'Not found.',
  429: 'Too many requests — try again shortly.',
  500: 'Server error — please retry.',
  502: 'Bad gateway — upstream service failed.',
  503: 'Service unavailable — try again shortly.',
  504: 'Gateway timeout — upstream service timed out.',
};

export async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) {
    // The server's own message wins (login carries "invalid password", the
    // middleware "session expired", the SQL guard its reason); only when the
    // response carries no body at all do we fall back to a status mapping.
    throw new Error(body?.error || STATUS_MESSAGES[res.status] || `HTTP ${res.status}`);
  }
  return body;
}
