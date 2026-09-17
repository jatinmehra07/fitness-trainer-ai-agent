import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // Allows production builds to successfully complete even if your project has ESLint errors
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Optional: ignore type errors during build if any pop up
    ignoreBuildErrors: true,
  },
};

export default nextConfig;