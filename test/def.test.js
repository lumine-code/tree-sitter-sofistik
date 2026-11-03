const assert = require("node:assert/strict");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const SOFiSTiK = require("..");
const { cases, texts, assertCase } = require("./def-cases");

test("exports a distinct DEF language with its own node types", () => {
  assert.equal(SOFiSTiK.def.name, "sofistik_def");
  assert.ok(SOFiSTiK.def.nodeTypeInfo.some((node) => node.type === "assignment"));
  assert.equal(
    SOFiSTiK.def.nodeTypeInfo.some((node) => node.type === "program"),
    false,
  );
});

for (const fixture of cases) {
  test(`DEF parses ${fixture.name}`, () => {
    const parser = new Parser();
    parser.setLanguage(SOFiSTiK.def);
    assertCase(parser.parse(fixture.source), fixture);
  });
}

test("DEF incremental edits preserve sections and assignment boundaries", () => {
  const parser = new Parser();
  parser.setLanguage(SOFiSTiK.def);
  const before = "[SOFiSTiK]\nKEY=49\n[MAPPING]\nNEXT=unchanged\n";
  const after = before.replace("49", "503 # literal");
  const tree = parser.parse(before);
  const startIndex = before.indexOf("49");
  tree.edit({
    startIndex,
    oldEndIndex: startIndex + 2,
    newEndIndex: startIndex + 13,
    startPosition: { row: 1, column: 4 },
    oldEndPosition: { row: 1, column: 6 },
    newEndPosition: { row: 1, column: 17 },
  });
  const updated = parser.parse(after, tree);
  assert.equal(updated.rootNode.hasError, false);
  assert.deepEqual(texts(updated, "value"), ["503 # literal", "unchanged"]);
  assert.equal(updated.rootNode.toString(), parser.parse(after).rootNode.toString());
  assert.deepEqual(
    updated.rootNode.descendantsOfType("section").map((node) => texts({ rootNode: node }, "key")),
    [["KEY"], ["NEXT"]],
  );
});
