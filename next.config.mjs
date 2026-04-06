/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["puppeteer", "puppeteer-core", "@puppeteer/browsers", "snowflake-sdk"],
};

export default nextConfig;
