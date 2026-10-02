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
    // `npm run test:coverage`: line/branch coverage of the dental screens and the
    // pages they feed. The HTML report lands in coverage/ (gitignored).
    coverage: {
      provider: "v8",
      include: [
        "src/features/dental/**",
        "src/features/dashboard/**",
        "src/features/scheduling/components/FollowupsView.tsx",
        "src/lib/ethiopian.ts",
      ],
      exclude: ["**/__tests__/**", "**/*.test.{ts,tsx}", "**/*.check.mjs"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "./coverage",
      // The ratchet: a change that leaves dental or dashboard code untested fails the
      // run. Set just under what was measured on 2026-10-02; raise them as tests are
      // added, never lower them without a reason in the commit message.
      thresholds: {
        "src/features/dental/**": { lines: 98.5, statements: 98.5, functions: 93, branches: 94.5 },
        "src/features/dashboard/**": { lines: 98, statements: 98, functions: 95, branches: 86.5 },
        "src/features/scheduling/components/FollowupsView.tsx": { lines: 95, statements: 95 },
      },
    },
  },
});
