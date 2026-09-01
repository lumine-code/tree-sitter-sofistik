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
  assert.deepStrictEqual(
    generators[0].descendantsOfType("generator_literal").map((node) => node.text),
    ["80", "89", "1"],
  );
  assert.strictEqual(generators[0].descendantsOfType("number").length, 0);
});

test("keeps hash variables visible inside a sequence generator", () => {
  const tree = parse("+PROG ASE\nGRP (24001 24000+#idt 1)\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  const generator = tree.rootNode.descendantsOfType("sequence_generator")[0];
  assert.deepStrictEqual(
    generator.descendantsOfType("generator_literal").map((node) => node.text),
    ["24001", "24000+", "1"],
  );
  assert.deepStrictEqual(
    generator.descendantsOfType("hash_variable").map((node) => node.text),
    ["#idt"],
  );
  assert.strictEqual(generator.descendantsOfType("number").length, 0);
});

test("does not claim single-component parenthesized expressions as generators", () => {
  const tree = parse("+PROG AQUA\nHEAD (#L_1) (D) (#L_1)+(#L_2-#L_1+#L_0)*(#i/(#L_n-1))\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("sequence_generator").length, 0);
  assert.strictEqual(tree.rootNode.descendantsOfType("generator_literal").length, 0);
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

test("ends an opaque DEFINE value before inline comments", () => {
  const tree = parse(
    "#define no = 119 ! only vertical live\n#define next = $(no)+1 $ reused value",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("preprocessor_value").map((node) => node.text.trimEnd()),
    ["= 119", "= $(no)+1"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("comment").map((node) => node.text),
    ["! only vertical live", "$ reused value"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("dollar_variable").length, 0);
});

test("keeps preprocessor conditionals flat across program scopes", () => {
  const tree = parse(
    "#if #version >= 2024 & (#enabled)\n+prog sofimsha\nnode 1 x 0\nend\n#elseif #version = 2023\n+prog aqua\nhead fallback\nend\n#else\nsys echo fallback\n#endif",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("preprocessor_block").length, 0);
  assert.strictEqual(tree.rootNode.descendantsOfType("preprocessor_program_block").length, 0);
  assert.deepStrictEqual(
    tree.rootNode.namedChildren.map((node) => node.type),
    [
      "preprocessor_if_header",
      "program",
      "preprocessor_elseif_header",
      "program",
      "preprocessor_else_header",
      "sys_statement",
      "preprocessor_endif_record",
    ],
  );

  const conditions = tree.rootNode.descendantsOfType("preprocessor_condition");
  assert.deepStrictEqual(
    conditions.map((node) => node.text),
    ["#version >= 2024 & (#enabled)", "#version = 2023"],
  );
  assert.ok(conditions.every((node) => node.namedChildCount === 0));
  assert.strictEqual(tree.rootNode.descendantsOfType("hash_variable").length, 0);
  assert.strictEqual(tree.rootNode.descendantsOfType("expression").length, 0);
});

test("preserves command context through flat preprocessor conditionals", () => {
  const tree = parse(
    "+prog sofimsha\nnode 1 x 0\n#if #use_second\nx 2 y 3\n#elseif #use_third\nx 4 y 5\n#else\nx 6 y 7\n#endif\nend",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(
    tree.rootNode.descendantsOfType("preprocessor_if_header")[0].parent.type,
    "input_block",
  );
  assert.strictEqual(
    tree.rootNode.descendantsOfType("preprocessor_else_header")[0].parent.type,
    "input_block",
  );
  assert.strictEqual(
    tree.rootNode.descendantsOfType("preprocessor_endif_record")[0].parent.type,
    "input_block",
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("implicit_record").length, 3);
  assert.deepStrictEqual(
    tree.rootNode
      .descendantsOfType("implicit_record")
      .map((record) =>
        record.descendantsOfType("item_name").map((node) => node.text.toUpperCase()),
      ),
    [
      ["X", "Y"],
      ["X", "Y"],
      ["X", "Y"],
    ],
  );
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

test("keeps a colliding enum-like token as a schema item", () => {
  const tree = parse("+PROG ASE\nGRP VAL NO\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("item_name").map((node) => node.text),
    ["VAL", "NO"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("enum_value").length, 0);
});

test("keeps enum-looking TENDON values as ordinary bare values", () => {
  const tree = parse("+PROG TENDON\nAXES KIND QUAD\nAXES VAL3 11 QUAD\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("enum_value").length, 0);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("bare_value").map((node) => node.text),
    ["QUAD", "11", "QUAD"],
  );
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
