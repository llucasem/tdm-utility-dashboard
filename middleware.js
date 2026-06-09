import { NextResponse } from 'next/server'

// Public paths reachable without a session. /api/health must be reachable by
// external uptime monitors (UptimeRobot, Better Uptime) without auth.
const PUBLIC_PATHS = ['/login', '/api/login', '/api/logout', '/privacy', '/eula', '/api/health']

// Constant-time string equality — defends against timing attacks on token
// comparison. Returns false on length mismatch or any character difference.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

export function middleware(request) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) return NextResponse.next()
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon')) return NextResponse.next()

  // Vercel cron auth. Two signals — both unspoofable from outside Vercel's edge:
  //   1. Legacy header `x-vercel-cron` (some Vercel plans still send it)
  //   2. Authorization: Bearer ${CRON_SECRET} (current Hobby behaviour since 2024,
  //      Vercel injects this when CRON_SECRET env var is set)
  if (request.headers.get('x-vercel-cron')) return NextResponse.next()
  const authHeader = request.headers.get('authorization')
  if (authHeader && process.env.CRON_SECRET && safeEqual(authHeader, `Bearer ${process.env.CRON_SECRET}`)) {
    return NextResponse.next()
  }

  const session = request.cookies.get('tdm_session')?.value
  const expected = process.env.APP_SESSION_TOKEN

  if (!session || !expected || !safeEqual(session, expected)) {
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
