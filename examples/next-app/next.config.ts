import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@flagforge/sdk"],
  poweredByHeader: false,
  devIndicators: false,
};

export default nextConfig;
