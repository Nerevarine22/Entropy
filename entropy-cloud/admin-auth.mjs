const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();
const tokenPattern = /^[a-f0-9]{64}$/;
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

async function sign(secret, payload) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

export function configuredAdmin(env) {
  return typeof env.ENTROPY_ADMIN_SECRET === 'string' && tokenPattern.test(env.ENTROPY_ADMIN_SECRET);
}

export function adminCookieName(url) {
  return url.protocol === 'https:' ? '__Host-entropy-admin' : 'entropy-admin-local';
}

export function adminActor(env) {
  return typeof env.ENTROPY_ADMIN_ID === 'string' && /^[a-z0-9_.@-]{1,100}$/i.test(env.ENTROPY_ADMIN_ID)
    ? env.ENTROPY_ADMIN_ID : 'admin';
}

export async function verifyAdminKey(secret, submitted) {
  if (typeof submitted !== 'string' || !tokenPattern.test(submitted)) return false;
  const [expected, candidate] = await Promise.all([sign(secret, 'entropy-login-v1'), sign(submitted, 'entropy-login-v1')]);
  return equalDigest(expected, candidate);
}

function equalDigest(expected, received) {
  if (!tokenPattern.test(received)) return false;
  let different = 0;
  for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return different === 0;
}

export async function adminSession(request, secret) {
  const name = adminCookieName(new URL(request.url));
  const cookie = request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='));
  if (!cookie) return false;
  const [expires, nonce, signature, extra] = cookie.slice(name.length + 1).split('.');
  const now = Math.floor(Date.now() / 1000);
  if (extra !== undefined || !/^\d{10}$/.test(expires) || !/^[a-f0-9-]{36}$/.test(nonce)
      || !tokenPattern.test(signature) || Number(expires) <= now || Number(expires) > now + SESSION_SECONDS) return false;
  return equalDigest(await sign(secret, 'entropy-session-v1:' + expires + '.' + nonce), signature);
}

export async function sessionCookie(url, secret) {
  const prefix = adminCookieName(url) + '=';
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const flags = '; Path=/; HttpOnly; SameSite=Strict' + secure;
  if (!secret) return prefix + '; Max-Age=0' + flags;
  const payload = Math.floor(Date.now() / 1000 + SESSION_SECONDS) + '.' + crypto.randomUUID();
  return prefix + payload + '.' + await sign(secret, 'entropy-session-v1:' + payload)
    + '; Max-Age=' + SESSION_SECONDS + flags;
}
