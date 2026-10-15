// SPDX-License-Identifier: Apache-2.0
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "selection/**",
      "designs/**",
      "**/node_modules/**",
      "**/dist/**",
      "artifacts/**",
      ".tmp/**",
      ".vscode-test/**",
      "coverage/**",
      "config.js",
      ".engine-ci/**",
      "packages/extension/skills/**",
      "packages/extension/runtime/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["skills/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.ts"],
    rules: {
      ...js.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
];
