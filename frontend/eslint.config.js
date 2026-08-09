// Deliberately narrow: this exists to catch ONE class of bug, not to enforce style.
//
// A React hook called below an early return makes the loading render and the loaded
// render disagree on how many hooks ran, and React responds by unmounting the whole
// tree — a blank white page with no message. That shipped to a live clinic once,
// because `tsc` compiles it happily and a bundle string-grep still finds every
// string in it. Only a static hook-order check catches it before deploy.
//
// Run: npm run lint
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "node_modules/**", "reference/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The one that matters. An error, never a warning — a warning inside a list
      // of warnings is a thing nobody reads.
      "react-hooks/rules-of-hooks": "error",
      // Stale-closure bugs: an effect reading state it never declared.
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
