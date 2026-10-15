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
      "packages/extension/skills/**",
      "packages/extension/runtime/**",
      "artifacts/**",
      ".tmp/**",
      ".vscode-test/**",
      "coverage/**",
      "config.js",
      ".engine-ci/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/extension/media/*.js"],
    languageOptions: {
      globals: { document: "readonly", window: "readonly", acquireVsCodeApi: "readonly" },
    },
    rules: { ...js.configs.recommended.rules },
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
    files: ["skills/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { process: "readonly", __dirname: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
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
