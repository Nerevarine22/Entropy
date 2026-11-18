import html from '../lib/entropy-html';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  // The private Site gate establishes identity. Never turn this into a public dashboard.
  if (!request.headers.get('oai-authenticated-user-id')) {
    const next = new URL('/signin-with-chatgpt', request.url);
    next.searchParams.set('return_to', '/');
    return Response.redirect(next, 302);
  }
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
  } });
}
