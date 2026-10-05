/** @type {import('next').NextConfig} */
const api = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8787';
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; connect-src 'self' ${api} ${api.replace(/^http/, 'ws')}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}; frame-ancestors 'none'`,
          },
        ],
      },
    ];
  },
};
export default nextConfig;
