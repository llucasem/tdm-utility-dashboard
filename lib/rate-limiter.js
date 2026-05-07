/**
 * Simple in-memory rate limiter with a sliding window.
 *
 * Keyed by IP address (or any string key the caller passes in). Good enough
 * for a single Vercel instance — for multi-region traffic at scale, swap in
 * Upstash Redis or similar.
 *
 * Usage:
 *    import { rateLimit, getClientIp } from '@/lib/rate-limiter';
 *
 *    export async function POST(request) {
 *      const ip = getClientIp(request);
 *      const allowed = rateLimit(`login:${ip}`, { max: 5, windowMs: 60_000 });
 *      if (!allowed.ok) {
 *        return Response.json({ ok: false, error: 'Too many attempts' }, {
 *          status: 429,
 *          headers: { 'Retry-After': String(Math.ceil(allowed.retryAfter / 1000)) },
 *        });
 *      }
 *      // ... handle request
 *    }
 */

const buckets = new Map(); // key -> Array<timestamp ms>

function pruneOldEntries() {
  const now    = Date.now();
  const cutoff = now - 5 * 60_000; // anything older than 5 minutes can go
  for (const [k, arr] of buckets) {
    const filtered = arr.filter(t => t >= cutoff);
    if (filtered.length === 0) buckets.delete(k);
    else if (filtered.length !== arr.length) buckets.set(k, filtered);
  }
}

// Periodically prune to avoid unbounded growth (no-op on serverless cold starts)
setInterval(pruneOldEntries, 60_000).unref?.();

/**
 * @param {string} key       any unique identifier (typically `prefix:ip`)
 * @param {object} opts
 * @param {number} opts.max         max events allowed in the window
 * @param {number} opts.windowMs    window length in milliseconds
 * @returns {{ ok: boolean, remaining: number, retryAfter: number }}
 */
export function rateLimit(key, { max, windowMs }) {
  const now    = Date.now();
  const cutoff = now - windowMs;
  const arr    = (buckets.get(key) || []).filter(t => t >= cutoff);

  if (arr.length >= max) {
    const oldest     = arr[0];
    const retryAfter = (oldest + windowMs) - now;
    buckets.set(key, arr);
    return { ok: false, remaining: 0, retryAfter };
  }

  arr.push(now);
  buckets.set(key, arr);
  return { ok: true, remaining: max - arr.length, retryAfter: 0 };
}

/** Pull the client IP from common headers (Vercel sets x-forwarded-for). */
export function getClientIp(request) {
  const xff  = request.headers.get('x-forwarded-for');
  const real = request.headers.get('x-real-ip');
  if (xff)  return xff.split(',')[0].trim();
  if (real) return real.trim();
  return 'unknown';
}
