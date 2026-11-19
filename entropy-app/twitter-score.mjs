const ENDPOINT = 'https://twitterscore.io/api/v1/get_followers_score_sum';
const DIAGNOSTICS = new Set([
  'api_key_missing', 'api_key_invalid', 'api_key_revoked', 'api_access_deactivated',
  'invalid_params', 'rate_limited', 'quota_exceeded', 'server_error',
]);

export const SMART_FOLLOWER_INTERVAL = 7 * 24 * 60 * 60 * 1000;

export class TwitterScoreError extends Error {
  constructor(code, retryAfterSeconds) {
    super(`TwitterScore request failed (${code}).`);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function fetchSmartFollowers(authorId, key, fetcher = fetch) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('twitter_id', authorId);
  let response;
  try {
    response = await fetcher(url, {
      headers: { 'X-API-Key': key, 'User-Agent': 'Entropy-Creators/1.0', Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new TwitterScoreError('network_error');
  }
  if (response.status >= 300 && response.status < 400) throw new TwitterScoreError('unexpected_redirect');

  const body = await response.json().catch(() => null);
  const code = body?.error?.code;
  if (body?.success === false && code === 'account_not_found') return null;
  if (body?.success === false || !response.ok) {
    const diagnostic = DIAGNOSTICS.has(code) ? code : response.status === 429 ? 'rate_limited' : `http_${response.status}`;
    const seconds = Number(response.headers.get('Retry-After'));
    throw new TwitterScoreError(diagnostic, Number.isFinite(seconds) && seconds > 0 ? seconds : undefined);
  }
  const count = body?.smart_followers_count;
  if (body?.success !== true || String(body.twitter_id) !== authorId || !Number.isSafeInteger(count) || count < 0) {
    throw new TwitterScoreError('invalid_response');
  }
  return count;
}
