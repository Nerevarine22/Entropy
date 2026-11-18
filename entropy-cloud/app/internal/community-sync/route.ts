import { syncCommunitySnapshot, WorkbenchError } from '../../../lib/workbench';

export const dynamic = 'force-dynamic';
const LIMIT = 1024;
const response = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });

// The existing owner-private Sites gate authenticates service access first.
// This header is explicit intent, not authentication. Never expose this Site.
async function checkRequest(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new WorkbenchError(403, 'ORIGIN_REJECTED', 'The request origin is not allowed.');
  if (request.headers.get('x-entropy-update') !== '1') throw new WorkbenchError(403, 'UPDATE_INTENT_REQUIRED', 'The update intent header is required.');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new WorkbenchError(415, 'INVALID_INPUT', 'Use application/json.');
  if (Number(request.headers.get('content-length')) > LIMIT) throw new WorkbenchError(413, 'TOO_LARGE', 'The request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new WorkbenchError(400, 'INVALID_INPUT', 'Send an empty JSON object.');
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const part = await reader.read(); if (part.done) break;
    length += part.value.byteLength;
    if (length > LIMIT) { await reader.cancel(); throw new WorkbenchError(413, 'TOO_LARGE', 'The request body is too large.'); }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length) throw new Error();
  } catch { throw new WorkbenchError(400, 'INVALID_INPUT', 'Send an empty JSON object.'); }
}

export async function POST(request: Request) {
  try { await checkRequest(request); return response(await syncCommunitySnapshot()); }
  catch (error) {
    if (error instanceof WorkbenchError) return response({ error: { code: error.code, message: error.message } }, error.status);
    return response({ error: { code: 'INTERNAL_ERROR', message: 'The public leaderboard could not be updated.' } }, 500);
  }
}
