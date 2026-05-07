import { NextResponse } from 'next/server'
import { rateLimit, getClientIp } from '@/lib/rate-limiter'

export async function POST(request) {
  const ip = getClientIp(request)

  // Allow up to 8 login attempts per 60 seconds per IP
  const limit = rateLimit(`login:${ip}`, { max: 8, windowMs: 60_000 })
  if (!limit.ok) {
    const retryAfterSec = Math.ceil(limit.retryAfter / 1000)
    return NextResponse.json(
      { error: `Too many login attempts. Try again in ${retryAfterSec} seconds.` },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec) } }
    )
  }

  const { password } = await request.json()

  if (password !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set('tdm_session', process.env.APP_SESSION_TOKEN, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    path: '/',
  })
  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('tdm_session')
  return response
}
