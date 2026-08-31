const { defineConfig } = require("eslint/config");
const globals = require("globals");

module.exports = defineConfig([
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
]);

