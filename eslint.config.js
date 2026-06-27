import tseslint from "typescript-eslint";

export default tseslint.config({
  files: ["src/server/**/*.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { sourceType: "module", ecmaVersion: 2022 },
  },
  rules: {
    // Module-boundary enforcement (TR-010, ADR-0005): feature modules MUST NOT import each
    // other's internals; cross-module wiring goes through the seam registry only. This rule
    // fails the build on a cross-module internal import so the monolith stays extractable.
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["**/modules/*/internal/**", "**/modules/*/internal"],
            message:
              "Cross-module internal import is forbidden; wire through src/server/modules/index.ts (TR-010).",
          },
        ],
      },
    ],
  },
});
