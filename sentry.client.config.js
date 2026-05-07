/**
 * Sentry — browser-side initialization.
 * Only kicks in if NEXT_PUBLIC_SENTRY_DSN is set, so unconfigured environments
 * stay silent.
 */
import * as Sentry from '@sentry/nextjs';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn:               process.env.NEXT_PUBLIC_SENTRY_DSN,
    tracesSampleRate:  0.1,
    environment:       process.env.NODE_ENV,
    // Avoid leaking PII like the user's email into Sentry breadcrumbs
    sendDefaultPii:    false,
  });
}
