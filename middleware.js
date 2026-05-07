import { NextResponse } from 'next/server'

const PUBLIC_PATHS = ['/login', '/api/login', '/api/logout', '/privacy', '/eula']

export function middleware(request) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next()
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) return NextResponse.next()

  // Vercel adds this header on legitimate cron invocations and strips it from
  // any incoming external request, so it cannot be spoofed.
  if (request.headers.get('x-vercel-cron')) return NextResponse.next()

  const session = request.cookies.get('tdm_session')?.value
  const expected = process.env.APP_SESSION_TOKEN

  if (!session || session !== expected) {
    // API calls expect JSON, not an HTML redirect — return 401 instead
    if (pathname.startsWith('/api/')) {
      return new NextResponse(
        JSON.stringify({ ok: false, error: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    }
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set('from', pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
