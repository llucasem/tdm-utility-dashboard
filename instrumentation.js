/**
 * Next.js instrumentation hook — runs once per server start.
 * Loads the appropriate Sentry config based on the runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError =
  process.env.SENTRY_DSN
    ? (await import('@sentry/nextjs')).captureRequestError
    : undefined;
