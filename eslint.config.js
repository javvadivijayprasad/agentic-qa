// Flat config (ESLint 9+). Same rule family as pw-emit / bdd2pw.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `examples/sandbox` is the agent's workspace: its contents are generated
    // by a run, so linting them would fail the package's own lint task on
    // output we did not write.
    ignores: [
      "dist/**",
      "node_modules/**",
      "examples/**/*.mjs",
      "examples/sandbox/**",
      "*.config.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
