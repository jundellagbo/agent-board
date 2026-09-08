import type { NextConfig } from "next";

// Tauri loads the frontend from disk, so everything must be a static asset:
// no server runtime, no image optimizer, directory-style URLs.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
