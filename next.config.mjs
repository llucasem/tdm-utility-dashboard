import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
};

// Wrap Next config with Sentry only if a DSN is configured. Otherwise return
// the bare config so unconfigured environments don't break.
export default process.env.SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      silent:           true,
      hideSourceMaps:   true,
      disableLogger:    true,
      // Required only if uploading source maps to Sentry
      // org / project / authToken come from env vars (SENTRY_ORG, SENTRY_PROJECT, SENTRY_AUTH_TOKEN)
    })
  : nextConfig;
