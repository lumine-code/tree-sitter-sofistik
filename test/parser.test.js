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
  const tree = parse("+PROG AQUA\r\nHEAD Example\r\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("program").length, 1);
  assert.strictEqual(tree.rootNode.descendantsOfType("command_name")[0].text, "HEAD");
});

test("uses schema commands before the dynamic TEMPLATE fallback", () => {
  const tree = parse("+PROG TEMPLATE\nHEAD Variables\nWHATEVER A B\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("command_name").map((node) => node.text),
    ["HEAD"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("dynamic_command_name").map((node) => node.text),
    ["WHATEVER"],
  );
});

test("exposes END and ENDE as control keywords", () => {
  const tree = parse("+PROG AQUA\nEND\nHEAD Again\nENDE");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("control_keyword").map((node) => node.text),
    ["END", "ENDE"],
  );
});

test("keeps hash variables visible next to units and inside calculations", () => {
  const tree = parse("+PROG SOFILOAD\nLINE QGRP 'PP' TYPE PG #q_bk[N/m] X1 #x1-#l_w/2 X2 #x2\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("hash_variable").map((node) => node.text),
    ["#q_bk", "#x1", "#l_w", "#x2"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("unit")[0].text, "[N/m]");
});

test("keeps a SOFiSTiK sequence generator in one node", () => {
  const tree = parse("+PROG ASE\nGRP (80 89 1) ICS1 11 PHIF 0\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  const generators = tree.rootNode.descendantsOfType("sequence_generator");
  assert.strictEqual(generators.length, 1);
  assert.strictEqual(generators[0].text, "(80 89 1)");
});

test("treats block DEFINE markers as transparent to the active module", () => {
  const tree = parse(
    "$prog maxima\n#define maxima-supp\nsupp $(no) mami auto\n#enddef\n+prog aqua\nend",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("preprocessor_define_block").length, 0);
  assert.strictEqual(
    tree.rootNode.descendantsOfType("preprocessor_define_header")[0].childForFieldName("name").text,
    "maxima-supp",
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("command_name").map((node) => node.text),
    ["supp"],
  );
});

test("keeps block DEFINE markers transparent after a command inside a program", () => {
  const tree = parse(
    "+prog maxima\nhead macro\n#define maxima-supp\nsupp $(no) mami auto\n#enddef\nend",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("command_name").map((node) => node.text),
    ["head", "supp"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("preprocessor_define_header").length, 1);
  assert.strictEqual(tree.rootNode.descendantsOfType("preprocessor_enddef_record").length, 1);
});

test("keeps a single-line DEFINE value opaque", () => {
  const tree = parse("#define p_poin = poin qgrp 'PP' type pg p #Q_w x #x y #y");
  assert.strictEqual(tree.rootNode.hasError, false);
  const statement = tree.rootNode.descendantsOfType("preprocessor_define_statement")[0];
  const value = statement.childForFieldName("value");
  assert.strictEqual(value.type, "preprocessor_value");
  assert.strictEqual(value.text, "= poin qgrp 'PP' type pg p #Q_w x #x y #y");
  assert.strictEqual(value.namedChildCount, 0);
  assert.strictEqual(statement.descendantsOfType("expression").length, 0);
});

test("uses dollar PROG only as a standalone scope directive", () => {
  const tree = parse("$prog maxima\nsupp 1\n$PROG\nplain text\n+prog aqua\nend");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("commented_program_header").length, 2);
  assert.strictEqual(tree.rootNode.descendantsOfType("program").length, 1);
  assert.strictEqual(tree.rootNode.descendantsOfType("command_name")[0].text, "supp");
});

test("accepts descriptive text between program scopes", () => {
  const tree = parse(
    "11 Belki prefabrykowane\n21 Poprzecznice podporowe\n+PROG AQUA\nEND\nDescription after a module",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("ignored_text").map((node) => node.text.trim()),
    ["11 Belki prefabrykowane", "21 Poprzecznice podporowe", "Description after a module"],
  );
});

test("keeps SYS and APPLY arguments ahead of the flat-text fallback", () => {
  const tree = parse('SYS command args\n+SYS wait copy "a.cdb" "b.cdb"\nAPPLY file.dat');
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode
      .descendantsOfType("sys_statement")
      .map((node) => node.childrenForFieldName("argument").map((argument) => argument.text)),
    [
      ["command", "args"],
      ["wait", "copy", '"a.cdb"', '"b.cdb"'],
    ],
  );
  assert.deepStrictEqual(
    tree.rootNode
      .descendantsOfType("apply_statement")[0]
      .childrenForFieldName("argument")
      .map((argument) => argument.text),
    ["file.dat"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("ignored_text").length, 0);
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

test("accepts include names while preserving the current command", () => {
  const tree = parse("+PROG SOFIMSHA\nNODE 1 X 0\n#INCLUDE blockase\nX 2 Y 0\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  const directive = tree.rootNode.descendantsOfType("preprocessor_directive")[0];
  assert.strictEqual(directive.childForFieldName("argument").text, "blockase");
  assert.strictEqual(tree.rootNode.descendantsOfType("implicit_record").length, 1);
});

test("allows input block terminators inside control flow", () => {
  const tree = parse("+PROG STAR2\nLOOP#1 1\nCTRL II 50\nEND\nENDLOOP\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("loop_block").length, 1);
  assert.strictEqual(tree.rootNode.descendantsOfType("end_record").length, 2);
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
