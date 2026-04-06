/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    "puppeteer-core",
    "@sparticuz/chromium",
    "@puppeteer/browsers",
    "snowflake-sdk",
  ],
};

export default nextConfig;
