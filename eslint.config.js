const { defineConfig } = require("eslint/config");
const eslint = require("@eslint/js");
const prettier = require("eslint-config-prettier");
const globals = require("globals");

module.exports = defineConfig([
  eslint.configs.recommended,
  {
    ignores: ["build/**", "node_modules/**", "src/parser.c"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["grammar.js"],
    languageOptions: {
      globals: {
        alias: "readonly",
        choice: "readonly",
        field: "readonly",
        grammar: "readonly",
        optional: "readonly",
        prec: "readonly",
        repeat: "readonly",
        repeat1: "readonly",
        seq: "readonly",
        token: "readonly",
      },
    },
  },
  prettier,
]);
