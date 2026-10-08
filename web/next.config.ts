import type { NextConfig } from 'next';
const config: NextConfig = { turbopack: { root: process.cwd() }, output: 'export', trailingSlash: true, images: { unoptimized: true }, poweredByHeader: false };
export default config;
