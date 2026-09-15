// Flat config (ESLint 9+). Same rule family as pw-emit / bdd2pw.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `examples/sandbox` is the agent's workspace: its contents are generated
    // by a run, so linting them would fail the package's own lint task on
    // output we did not write.
    // `extension/` is a separate package with its own tsconfig, its own
    // release cycle and its own dependencies. `extension/out` is compiled
    // CommonJS, which this config's ESM rules reject on sight — so linting it
    // here fails the runtime's lint task on generated output belonging to a
    // different package. It brings its own linting when it needs it.
    ignores: [
      "dist/**",
      "node_modules/**",
      "examples/**/*.mjs",
      "examples/sandbox/**",
      "extension/**",
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
