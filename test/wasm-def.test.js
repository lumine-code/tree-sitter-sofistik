const path = require("node:path");
const { before, test } = require("node:test");
const { Parser, Language } = require("web-tree-sitter");
const { cases, assertCase } = require("./def-cases");

let language;
before(async () => {
  await Parser.init();
  language = await Language.load(path.join(__dirname, "..", "def", "sofistik-def.wasm"));
});

for (const fixture of cases) {
  test(`Wasm DEF parses ${fixture.name}`, () => {
    const parser = new Parser();
    parser.setLanguage(language);
    let tree;
    try {
      tree = parser.parse(fixture.source);
      assertCase(tree, fixture);
    } finally {
      tree?.delete();
      parser.delete();
    }
  });
}
