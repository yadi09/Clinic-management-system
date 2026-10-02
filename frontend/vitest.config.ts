// Unit and component tests (Vitest + jsdom + Testing Library). Browser end-to-end
// tests live in e2e/ and run under Playwright (playwright.config.ts), not here.
//
// Every test title carries its regression ID, e.g. "REG-FE-VISIT-001 ...", so a
// failure names the behaviour it protects. Run one area with `npx vitest run -t REG-FE-VISIT`.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
