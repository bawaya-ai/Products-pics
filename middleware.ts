import { NextRequest, NextResponse } from 'next/server';

// Inlined (NOT imported from core/auth) so this Edge bundle stays free of node:crypto.
const SESSION_COOKIE = 'sp_session';

// Coarse routing + presence gate only. The authoritative signature/role checks run
// server-side (Node) in each route handler / server component.
export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') || '').split(':')[0];
  const isAdminHost = host.startsWith('admin.');
  const { pathname } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  const isAuthPage = pathname === '/login' || pathname === '/reset';

  // The admin subdomain lands on /admin.
  if (isAdminHost && pathname === '/') {
    const u = req.nextUrl.clone(); u.pathname = '/admin'; return NextResponse.redirect(u);
  }
  // Any page (not APIs, not the auth pages) needs a session cookie present.
  if (!hasSession && !isAuthPage && !pathname.startsWith('/api')) {
    const u = req.nextUrl.clone(); u.pathname = '/login'; u.searchParams.set('next', pathname);
    return NextResponse.redirect(u);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|css|js)$).*)'],
};
