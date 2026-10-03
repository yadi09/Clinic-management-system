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
    // Whole-page tests (the dental workspace, chairside, exams) take 5–10 s under
    // coverage on a busy machine; at the 5 s default they failed at random during
    // the time sweep. A slow test is not a broken behaviour.
    testTimeout: 20_000,
    // `npm run test:coverage`: line/branch coverage of every screen a dental clinic can
    // open. The HTML report lands in coverage/ (gitignored). Excluded, mirroring the API
    // gate's scripts/test/dental-scope.txt: modules switched off in the dental preset
    // (lab, pharmacy, inpatient, maternity, the Ministry report), the general-clinic
    // consultation workspace, and the vendor's own marketing tools (CRM, campaigns).
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "**/__tests__/**", "**/*.test.{ts,tsx}", "**/*.check.mjs",
        "src/main.tsx", "src/vite-env.d.ts", "src/test/**",
        "src/features/lab/**", "src/features/pharmacy/**", "src/features/inpatient/**",
        "src/features/maternity/**", "src/features/reporting/**", "src/features/campaign/**",
        "src/features/platform/campaign/**", "src/features/platform/crm/**",
        "src/features/clinical/pages/EncounterWorkspacePage.tsx",
        "src/features/clinical/components/DictateButton.tsx",
        "src/features/clinical/components/PatientStory.tsx",
        "src/features/clinical/components/WorkSection.tsx",
      ],
      reporter: ["text-summary", "html"],
      reportsDirectory: "./coverage",
      // The ratchet: a change that leaves a screen untested fails the run. Each number
      // is set just under what was measured on 2026-10-03; raise them as tests are
      // added, never lower them without a reason in the commit message.
      thresholds: {
        "src/features/dental/**": { lines: 98.5, statements: 98.5, functions: 93, branches: 94.5 },
        "src/features/dashboard/**": { lines: 98, statements: 98, functions: 95, branches: 86.5 },
        "src/features/scheduling/**": { lines: 99.5, statements: 99.5, functions: 94.5, branches: 96 },
        "src/features/patients/**": { lines: 99.5, statements: 99.5, functions: 98, branches: 96 },
        "src/features/billing/**": { lines: 99.5, statements: 99.5, functions: 98, branches: 96 },
        "src/features/notifications/**": { lines: 99.5, statements: 99.5, functions: 99.5, branches: 98.5 },
        "src/features/messaging/**": { lines: 96.5, statements: 96.5, functions: 86.5, branches: 97 },
        "src/features/admin/**": { lines: 99.5, statements: 99.5, functions: 95, branches: 96.5 },
        "src/features/auth/**": { lines: 99.5, statements: 99.5, functions: 99.5, branches: 98 },
        "src/features/platform/**": { lines: 99.5, statements: 99.5, functions: 94, branches: 95.5 },
        "src/app/**": { lines: 99.5, statements: 99.5, functions: 97.5, branches: 99 },
        "src/components/**": { lines: 97, statements: 97, functions: 97.5, branches: 97 },
        "src/lib/**": { lines: 99.5, statements: 99.5, functions: 99.5, branches: 95 },
        "src/features/clinical/**": { lines: 98, statements: 98, functions: 95.5, branches: 93.5 },
        "src/features/help/**": { lines: 99.5, statements: 99.5, functions: 99.5, branches: 99.5 },
        "src/features/misc/**": { lines: 99.5, statements: 99.5, functions: 99.5, branches: 99.5 },
        "src/hooks/**": { lines: 99.5, statements: 99.5, functions: 99.5, branches: 99.5 },
        // Everything in scope together, so a new folder cannot start life untested.
        lines: 99, statements: 99, functions: 95, branches: 95.5,
      },
    },
  },
});
