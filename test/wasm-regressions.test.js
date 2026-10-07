const { before, test } = require("node:test");
const path = require("node:path");
const { Parser, Language } = require("web-tree-sitter");
const { registerParserRegressions } = require("./parser-regressions");

let language;
before(async () => {
  await Parser.init();
  language = await Language.load(path.join(__dirname, "..", "tree-sitter-sofistik.wasm"));
});

registerParserRegressions(test, () => {
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
});
