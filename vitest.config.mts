import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // scripts/ is included so the device agent's own enforcement —
    // validateReadOnlyCommand, resolveTarget, redactSecrets — is covered. That
    // code runs on a real employee's machine with the privileges the agent was
    // installed with, and it was the one part of this system with no tests.
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
  },
});
