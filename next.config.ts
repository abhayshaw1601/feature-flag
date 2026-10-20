import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@flagforge/contracts"],
};

export default nextConfig;
