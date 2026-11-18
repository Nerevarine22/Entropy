const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (error, status) => Response.json({ error }, { status, headers: privateHeaders });

export default {
  async fetch(request) {
    try {
      if (!['GET', 'POST'].includes(request.method)) return json('Method not allowed.', 405);
      const here = new URL(request.url);
      const upstream = new URL(process.env.LEADERBOARD_API_URL);
      if (upstream.protocol !== 'https:' || !upstream.hostname.endsWith('.workers.dev') || upstream.port
          || upstream.username || upstream.password || upstream.pathname !== '/api/leaderboard' || upstream.search || upstream.hash) {
        return json('Moderation is temporarily unavailable.', 503);
      }
      upstream.pathname = '/api/admin';
      for (const [name, limit] of [['view', 8], ['creator', 24], ['page', 6], ['q', 81], ['status', 12]]) {
        const value = here.searchParams.get(name);
        if (value !== null) upstream.searchParams.set(name, value.slice(0, limit));
      }
      const headers = new Headers({ Accept: 'application/json' });
      const session = request.headers.get('Cookie')?.split(';').map(value => value.trim())
        .find(value => /^__Host-entropy-admin=/.test(value));
      if (session) headers.set('Cookie', session);
      let body;
      if (request.method === 'POST') {
        if (request.headers.get('Origin') !== here.origin) return json('The origin of the request is not allowed.', 403);
        if (Number(request.headers.get('Content-Length')) > 8192) return json('Request is too large.', 413);
        headers.set('Origin', upstream.origin);
        headers.set('Content-Type', request.headers.get('Content-Type') || '');
        body = await request.arrayBuffer();
        if (body.byteLength > 8192) return json('Request is too large.', 413);
      }
      const response = await fetch(upstream, {
        method: request.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(12000),
      });
      if (!response.headers.get('Content-Type')?.includes('application/json')) return json('Moderation is temporarily unavailable.', 503);
      const resultHeaders = new Headers({ ...privateHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      const cookie = response.headers.get('Set-Cookie');
      if (cookie?.startsWith('__Host-entropy-admin=')) resultHeaders.set('Set-Cookie', cookie);
      return new Response(response.body, { status: response.status, headers: resultHeaders });
    } catch {
      return json('Moderation is temporarily unavailable.', 503);
    }
  },
};
