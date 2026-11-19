import { adminActor, adminSession, configuredAdmin, sessionCookie, verifyAdminKey } from './admin-auth.mjs';
import { adminProfile, moderate, ModerationError } from './moderation-store.mjs';
import { reviewCampaignPost } from './campaign-store.mjs';

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200, cookie) => Response.json(body, {
  status, headers: cookie ? { ...headers, 'Set-Cookie': cookie } : headers,
});

async function readInput(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) {
    throw new ModerationError(415, 'Use a JSON request.');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ModerationError(400, 'A request body is required.');
  const decoder = new TextDecoder();
  let text = '', size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) {
      await reader.cancel();
      throw new ModerationError(413, 'Moderation request is too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  let value;
  try { value = JSON.parse(text + decoder.decode()); }
  catch { throw new ModerationError(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModerationError(400, 'Invalid request.');
  return value;
}

export async function handleAdmin(request, env, loadRanking, loadCampaignReview) {
  const url = new URL(request.url);
  try {
    if (!configuredAdmin(env)) throw new ModerationError(503, 'Admin sign-in is not configured.');
    const secret = env.ENTROPY_ADMIN_SECRET;
    const authenticated = await adminSession(request, secret);
    if (request.method === 'GET') {
      if (url.searchParams.get('view') === 'session') return json({ authenticated });
      if (!authenticated) throw new ModerationError(401, 'Sign in to open moderation.');
      if (url.searchParams.get('view') === 'ranking') return json(await loadRanking(url));
      if (url.searchParams.get('view') === 'weekly') return json(await loadCampaignReview(url));
      if (url.searchParams.get('view') === 'profile') {
        return json(await adminProfile(env.DB, url.searchParams.get('creator'), url.searchParams.get('page')));
      }
      throw new ModerationError(404, 'Unknown admin view.');
    }
    if (request.method !== 'POST') throw new ModerationError(405, 'Method not allowed.');
    if (request.headers.get('Origin') !== url.origin) throw new ModerationError(403, 'The origin of the request is not allowed.');
    const input = await readInput(request);
    if (input.action === 'login') {
      if (!await verifyAdminKey(secret, input.key)) throw new ModerationError(401, 'Invalid admin access key.');
      return json({ authenticated: true }, 200, await sessionCookie(url, secret));
    }
    if (!authenticated) throw new ModerationError(401, 'Sign in to open moderation.');
    if (input.action === 'logout') return json({ authenticated: false }, 200, await sessionCookie(url));
    if (input.action === 'campaign-review') await reviewCampaignPost(env.DB, input, adminActor(env));
    else await moderate(env.DB, input, adminActor(env));
    return json({ saved: true });
  } catch (error) {
    if (error instanceof ModerationError) return json({ error: error.message }, error.status);
    return json({ error: 'Moderation is temporarily unavailable.' }, 503);
  }
}
