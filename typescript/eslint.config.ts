// Flat config entrypoint. `eslint.strict.ts` next to this file is SYNCED --
// `sarj-standards setup` overwrites it, and `setup --dry-run` fails CI if
// you edit it. Put every repo-specific decision HERE instead, in the override
// block below: later entries win, so you can relax a rule, add a framework
// exemption, or scope one to a directory without forking the canonical file.
import { createConfig } from "./eslint.strict.ts";
import tseslint from "typescript-eslint";

export default [
  ...createConfig({
    projectService: {
      allowDefaultProject: [
        "packages/source-collector/vitest.config.ts",
        "packages/source-collector/src/source-adapter/__tests__/source-adapter.test.ts",
      ],
      maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 4,
    },
  }),
  {
    ignores: [
      // These directories contain authored source, not compiled library output.
      "!packages/*/src/lib/",
      "!packages/*/src/lib/**",
      ".yarn/**",
      "packages/operations/.open-next/**",
    ],
  },
  {
    // Native Node and browser harnesses retain their execution-test coverage.
    files: [
      "scripts/**/*.ts",
      "chrome/**/*.ts",
      "packages/site/tests/**/*.ts",
      "eslint.config.ts",
    ],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["chrome/**/*.ts"],
    languageOptions: {
      sourceType: "script",
      globals: {
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        AbortController: "readonly",
        URL: "readonly",
        chrome: "readonly",
        importScripts: "readonly",
        projectSaqiPage: "readonly",
        document: "readonly",
        location: "readonly",
        SAQI_SOURCE_ORIGIN: "readonly",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@sarj/prefer-module-level-schema": ["error", { minProperties: 1 }],
    },
  },
  {
    files: ["packages/site/src/pages/**/*.ts"],
    rules: {
      "unicorn/filename-case": [
        "error",
        { cases: { kebabCase: true }, ignore: [String.raw`\[.+\]`] },
      ],
    },
  },
];
