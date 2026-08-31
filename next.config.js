/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
    ],
  },
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  async redirects() {
    return [
      { source: '/port', destination: '/studio', permanent: true },
      { source: '/port/:path*', destination: '/studio/:path*', permanent: true },
    ]
  },
  async rewrites() {
    return [{ source: '/mcp', destination: '/api/mcp' }]
  },
}

module.exports = nextConfig
