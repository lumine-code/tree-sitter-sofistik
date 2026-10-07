const { test } = require("node:test");
const Parser = require("tree-sitter");
const language = require("..");
const { registerParserRegressions } = require("./parser-regressions");

registerParserRegressions(test, () => {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
});
