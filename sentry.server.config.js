/**
 * Sentry — server-side initialization (Node runtime).
 * Captures unhandled errors in API routes and server components.
 */
import * as Sentry from '@sentry/nextjs';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn:              process.env.SENTRY_DSN,
    tracesSampleRate: 0.1,
    environment:      process.env.NODE_ENV,
    sendDefaultPii:   false,
  });
}
