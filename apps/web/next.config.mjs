const isDev = process.env.NODE_ENV !== 'production';

// Next's dev server evaluates strings for HMR and source maps, so 'unsafe-eval'
// is required to hydrate locally. Production needs no such thing, and shipping
// it there would defeat most of the point of having a CSP.
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @bithook/core ships TypeScript source rather than a build step.
  transpilePackages: ['@bithook/core'],
  // Self-contained server bundle, so the box only needs node — no pnpm install
  // and no node_modules on the production host.
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // @bithook/core is TypeScript source using ESM-style './foo.js' specifiers
  // (required so plain Node can run the source directly). vitest and tsc map those
  // onto .ts themselves; webpack does not, so tell it to.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
          // The page makes no outbound requests of its own: chain reads happen
          // server-side, so the browser never learns which RPC is in use.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "font-src 'self'",
              "base-uri 'none'",
              "form-action 'none'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
