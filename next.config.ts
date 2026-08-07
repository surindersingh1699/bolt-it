import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Windows VM reaches this dev server cross-origin (via the hypervisor host
  // IP, e.g. http://192.168.217.1:3000), not on localhost. Next 16 blocks the
  // dev-time client runtime for origins it does not recognise, which leaves the
  // page served but never hydrated — dead buttons, empty state. Allowlisting the
  // VM-facing hosts lets the guest run the client exactly as localhost does.
  // Dev-only; ignored by a production build.
  allowedDevOrigins: ["192.168.217.1", "192.168.15.1", "10.209.206.90"],
};

export default nextConfig;
