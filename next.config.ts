import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Google profile photos for the presence wall and the user menu (CH-3).
    // Only this one host is allowed; the wildcard *.googleusercontent.com
    // entry from skylite is deliberately not copied.
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com", pathname: "/**" },
    ],
  },
};

export default nextConfig;
