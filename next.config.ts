import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Independent local previews must not overwrite another phase's build output.
  distDir: process.env.NEXT_BUILD_DIR || ".next",
  output: "standalone",
  transpilePackages: ["@flagforge/contracts"],
};

export default nextConfig;
