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
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok || !response.headers.get('Content-Type')?.includes('application/json')) return unavailable();
      return new Response(response.body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=30, s-maxage=60',
        },
      });
    } catch {
      return unavailable();
    }
  },
};
