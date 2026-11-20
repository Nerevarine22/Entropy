import { createHmac } from 'node:crypto';
import { createMyStatsHandler } from '../x-sign-in.mjs';

function productionOrigin() {
  const url = new URL(process.env.X_OAUTH_ORIGIN || 'https://entropy-entropy-app.vercel.app');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('X_OAUTH_ORIGIN must be an HTTPS origin.');
  }
  return url.origin;
}

export function statsServiceKey(secret) {
  return createHmac('sha256', secret).update('entropy-stats-service-v1').digest('hex');
}

export async function handleProductionMyStats(request, action = '') {
  try {
    const sessionSecret = process.env.X_SESSION_SECRET?.trim();
    const configured = /^[a-f0-9]{64}$/.test(sessionSecret ?? '');
    const handle = createMyStatsHandler({ origin: productionOrigin(), sessionSecret,
      clientId: configured ? process.env.X_CLIENT_ID?.trim() : undefined,
      clientSecret: configured ? process.env.X_CLIENT_SECRET?.trim() : undefined,
      async getStats(id) {
        const url = new URL(process.env.LEADERBOARD_API_URL);
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.port || url.username || url.password
            || url.pathname !== '/api/leaderboard' || url.search || url.hash) throw new Error('Invalid leaderboard service URL.');
        url.pathname = '/internal/my-stats';
        url.searchParams.set('creator', id);
        const response = await fetch(url, { headers: { Authorization: 'Bearer ' + statsServiceKey(sessionSecret) },
          redirect: 'error', signal: AbortSignal.timeout(9000) });
        if (!response.ok) throw new Error('The leaderboard service did not return the creator stats.');
        return response.json();
      },
    });
    return await handle(request, action);
  } catch {
    return Response.json({ error: 'My Stats is temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export default { fetch: request => handleProductionMyStats(request) };
