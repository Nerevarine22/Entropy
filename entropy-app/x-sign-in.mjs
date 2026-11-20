import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STATE_TTL = 10 * 60;
const SESSION_TTL = 7 * 24 * 60 * 60;
const STATE_COOKIE = 'entropy-x-state';
const SESSION_COOKIE = 'entropy-x-session';
const PATH = '/api/my-stats';
const STATS_PAGE = '/#my-stats';
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const nonce = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
const cookieName = (url, name) => url.protocol === 'https:' ? '__Host-' + name : name;

function signed(secret, purpose, payload, ttl) {
  const data = Buffer.from(JSON.stringify({ ...payload, expires: now() + ttl })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${purpose}.${data}`).digest('base64url');
  return `${data}.${signature}`;
}

function readCookie(request, name, secret) {
  const requestCookieName = cookieName(new URL(request.url), name);
  const value = request.headers.get('Cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(`${requestCookieName}=`))?.slice(requestCookieName.length + 1);
  const match = /^([\w-]{1,3500})\.([\w-]{43})$/.exec(value ?? '');
  if (!match) return null;
  const [, data, signature] = match;
  const expected = createHmac('sha256', secret).update(`${name}.${data}`).digest('base64url');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return payload.expires > now() ? payload : null;
  } catch { return null; }
}

function cookie(name, value, age, url) {
  const https = url.protocol === 'https:';
  return `${cookieName(url, name)}=${value}; Max-Age=${age}; Path=${https ? '/' : PATH}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
}

function redirect(location, cookies = []) {
  const responseHeaders = new Headers({ ...headers, Location: location });
  for (const value of cookies) responseHeaders.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers: responseHeaders });
}

function avatar(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'https://pbs.twimg.com' && !url.username && !url.password && /^\/profile_images\//.test(url.pathname)) {
      return url.origin + url.pathname;
    }
  } catch { /* The account can sign in without an avatar. */ }
  return null;
}

async function verifyXAccount({ clientId, clientSecret, redirectUri, code, verifier, fetcher }) {
  const response = await fetcher('https://api.x.com/2/oauth2/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64') },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  if (!response.ok) throw new Error('X rejected the authorization code.');
  const { access_token: token } = await response.json();
  if (typeof token !== 'string' || !token) throw new Error('Missing X access token.');
  const profile = await fetcher('https://api.x.com/2/users/me?user.fields=profile_image_url', {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!profile.ok) throw new Error('X did not return the account.');
  const { data } = await profile.json();
  if (typeof data?.id !== 'string' || !/^[1-9]\d{0,23}$/.test(data.id) ||
      typeof data.username !== 'string' || !/^[A-Za-z0-9_]{1,15}$/.test(data.username)) {
    throw new Error('Invalid X account.');
  }
  return { id: data.id, handle: data.username,
    displayName: typeof data.name === 'string' ? data.name.slice(0, 100) : data.username, avatarUrl: avatar(data.profile_image_url) };
}

export function createMyStatsHandler({ origin, clientId, clientSecret, getStats, sessionSecret = nonce(), fetcher = fetch }) {
  const configured = Boolean(clientId && clientSecret);
  const redirectUri = `${origin}${PATH}/callback`;
  const json = (body, status = 200) => Response.json(body, { status, headers });

  return async function handle(request, action) {
    const url = new URL(request.url);
    action ??= url.pathname.slice(PATH.length);
    if (action === '/logout') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      if (request.headers.get('Origin') !== url.origin) return json({ error: 'The request origin is not allowed.' }, 403);
      const response = json({ signedOut: true });
      response.headers.append('Set-Cookie', cookie(SESSION_COOKIE, '', 0, url));
      response.headers.append('Set-Cookie', cookie(STATE_COOKIE, '', 0, url));
      return response;
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);

    if (action === '/start') {
      if (!configured) return redirect('/?x_login=unavailable#my-stats');
      if (url.origin !== origin) return redirect(`${origin}${PATH}/start`);
      const state = nonce(), verifier = nonce();
      const authorize = new URL('https://x.com/i/oauth2/authorize');
      authorize.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
        scope: 'users.read tweet.read', state, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url') });
      return redirect(authorize.href, [cookie(STATE_COOKIE, signed(sessionSecret, STATE_COOKIE, { state, verifier }, STATE_TTL), STATE_TTL, url)]);
    }

    if (action === '/callback') {
      const cleared = cookie(STATE_COOKIE, '', 0, url);
      const state = readCookie(request, STATE_COOKIE, sessionSecret);
      const code = url.searchParams.get('code');
      if (!configured || url.origin !== origin || !state || state.state !== url.searchParams.get('state')) {
        return redirect('/?x_login=failed#my-stats', [cleared]);
      }
      if (url.searchParams.get('error') === 'access_denied') return redirect('/?x_login=cancelled#my-stats', [cleared]);
      if (!code || code.length > 2048) return redirect('/?x_login=failed#my-stats', [cleared]);
      try {
        const account = await verifyXAccount({ clientId, clientSecret, redirectUri, code, verifier: state.verifier, fetcher });
        const session = signed(sessionSecret, SESSION_COOKIE, { account }, SESSION_TTL);
        return redirect(STATS_PAGE, [cleared, cookie(SESSION_COOKIE, session, SESSION_TTL, url)]);
      } catch { return redirect('/?x_login=failed#my-stats', [cleared]); }
    }

    if (action !== '') return json({ error: 'Unknown My Stats request.' }, 404);
    const account = configured ? readCookie(request, SESSION_COOKIE, sessionSecret)?.account : null;
    if (!account) return json({ configured, account: null });
    try { return json({ configured, account, stats: await getStats(account.id, url) }); }
    catch { return json({ configured, account, error: 'Your stats are temporarily unavailable. Try again.' }, 503); }
  };
}
