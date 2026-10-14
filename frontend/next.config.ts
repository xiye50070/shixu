import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "@copilotkit/sqlite-runner", "@copilotkit/runtime"],
  distDir: process.env.NEXT_DIST_DIR || ".next",
  agentRules: false,
  devIndicators: false,
};

export default nextConfig;
