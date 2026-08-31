const assert = require("node:assert");
const { test } = require("node:test");
const Parser = require("tree-sitter");
const SOFiSTiK = require("..");

function parse(source) {
  const parser = new Parser();
  parser.setLanguage(SOFiSTiK);
  return parser.parse(source);
}

test("parses CRLF input without a final newline", () => {
  const tree = parse("$PROG AQUA\r\nHEAD Example\r\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("program").length, 1);
  assert.strictEqual(tree.rootNode.descendantsOfType("command_name")[0].text, "HEAD");
});

test("keeps the module inside the stable program header field", () => {
  const tree = parse("+PROG SOFIMSHA\nNODE 1\nEND");
  const program = tree.rootNode.namedChild(0);
  const header = program.childForFieldName("header");
  assert.strictEqual(header.type, "program_header");
  assert.strictEqual(header.childForFieldName("module").text, "SOFIMSHA");
});

test("selects an enum over a colliding item immediately after its owner", () => {
  const tree = parse("+PROG ASE\nGRP VAL NO\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("item_name")[0].text, "VAL");
  assert.strictEqual(tree.rootNode.descendantsOfType("enum_value")[0].text, "NO");
});

test("marks globally known names that are invalid in the current context", () => {
  const tree = parse("+PROG AQUA\nNODE 1\nEND\n+PROG UNKNOWN\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("invalid_command")[0].text, "NODE");
  assert.strictEqual(tree.rootNode.descendantsOfType("invalid_module")[0].text, "UNKNOWN");
});

test("preserves command state across a variable statement", () => {
  const tree = parse("+PROG SOFIMSHA\nNODE 1 X 0\nLET#A =1\nX 2 Y 0\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  const inherited = tree.rootNode.descendantsOfType("implicit_record").at(-1);
  assert.deepStrictEqual(
    inherited.descendantsOfType("item_name").map((node) => node.text),
    ["X", "Y"],
  );
});

test("keeps text block contents opaque", () => {
  const tree = parse(
    "+PROG AQUA\nHEAD 'a; $ PROG'\n<TEXT>\nPROG not parsed; $ not comment\n</TEXT>\nEND",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("string")[0].text, "'a; $ PROG'");
  assert.match(tree.rootNode.descendantsOfType("text_content")[0].text, /PROG not parsed/);
  assert.strictEqual(tree.rootNode.descendantsOfType("comment").length, 0);
});

test("restores contextual scanner state during an incremental reparse", () => {
  const parser = new Parser();
  parser.setLanguage(SOFiSTiK);
  const source = "+PROG SOFIMSHA\nNODE 1 X 0 Y 0\nEND";
  const changed = "+PROG SOFIMSHA\nNODE 1 X 2 Y 0\nEND";
  const tree = parser.parse(source);
  const index = source.indexOf("0", source.indexOf("NODE"));
  const point = { row: 1, column: index - source.indexOf("NODE") };
  tree.edit({
    startIndex: index,
    oldEndIndex: index + 1,
    newEndIndex: index + 1,
    startPosition: point,
    oldEndPosition: { row: point.row, column: point.column + 1 },
    newEndPosition: { row: point.row, column: point.column + 1 },
  });

  const reparsed = parser.parse(changed, tree);
  assert.strictEqual(reparsed.rootNode.hasError, false);
  assert.deepStrictEqual(
    reparsed.rootNode.descendantsOfType("item_name").map((node) => node.text),
    ["X", "Y"],
  );
});
