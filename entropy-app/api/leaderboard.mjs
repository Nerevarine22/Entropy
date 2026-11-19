function unavailable() {
  return Response.json({ error: 'Leaderboard temporarily unavailable.' }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request) {
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET' } });
    try {
      const url = new URL(process.env.LEADERBOARD_API_URL);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.port
          || url.username || url.password || url.pathname !== '/api/leaderboard' || url.search || url.hash) {
        return unavailable();
      }
      const requested = new URL(request.url).searchParams;
      for (const [key, maxLength] of [['view', 8], ['creator', 24], ['page', 6], ['q', 81], ['week', 40]]) {
        const value = requested.get(key);
        if (value !== null) url.searchParams.set(key, value.slice(0, maxLength));
      }
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Entropy-Creators/1.0' },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!(response.ok || [400, 404].includes(response.status))
          || !response.headers.get('Content-Type')?.includes('application/json')) return unavailable();
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': response.headers.get('Cache-Control') || 'no-store',
        },
      });
    } catch {
      return unavailable();
    }
  },
};
