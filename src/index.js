import { Router } from 'itty-router';

const router = Router();

// Health check
router.get('/health', () => {
  return new Response('OK', { status: 200 });
});

// API routes can be added here
// router.get('/api/object', (req, env) => { ... });

// Fallback: serve static files from public/
router.all('*', async (req, env) => {
  const url = new URL(req.url);
  let pathname = url.pathname;

  // Default to index.html for root
  if (pathname === '/') {
    pathname = '/index.html';
  }

  // Attempt to fetch static file from public/
  try {
    const response = await env.ASSETS.fetch(new Request(new URL(pathname, req.url).toString(), req));
    if (response.status !== 404) {
      return response;
    }
  } catch (e) {
    // Fall through to 404
  }

  // If file not found, serve index.html (SPA fallback)
  try {
    return await env.ASSETS.fetch(new Request(new URL('/index.html', req.url).toString(), req));
  } catch (e) {
    return new Response('Not Found', { status: 404 });
  }
});

export default {
  fetch: router.handle,
};
