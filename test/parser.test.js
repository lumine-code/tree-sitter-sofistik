const assert = require("node:assert");
const { performance } = require("node:perf_hooks");
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

test(
  "scales quoted TEMPLATE records across one semicolon-delimited line",
  { timeout: 10000 },
  () => {
    const makeSource = (count) =>
      `+PROG TEMPLATE\n${Array.from({ length: count }, (_, index) => {
        const suffix = String(index).padStart(4, "0");
        return `CMD${suffix} #VALUE${suffix} "quoted value"`;
      }).join(" ; ")}\nEND`;
    const smallRecordCount = 128;
    const scale = 16;
    const smallSource = makeSource(smallRecordCount);
    const largeSource = makeSource(smallRecordCount * scale);
    const parser = new Parser();
    parser.setLanguage(SOFiSTiK);

    const measureFastest = (source, repetitions) => {
      let fastest = Infinity;
      for (let round = 0; round < 3; round++) {
        const trees = [];
        const started = performance.now();
        for (let index = 0; index < repetitions; index++) {
          trees.push(parser.parse(source));
        }
        fastest = Math.min(fastest, performance.now() - started);
        assert.ok(trees.every((tree) => !tree.rootNode.hasError));
      }
      return fastest;
    };

    parser.parse(smallSource);
    parser.parse(largeSource);
    const smallBatchDuration = measureFastest(smallSource, scale);
    const largeDuration = measureFastest(largeSource, 1);
    assert.ok(
      largeDuration < smallBatchDuration * 6,
      `single-line parse scaled superlinearly: ${smallBatchDuration.toFixed(1)}ms for ${scale} small parses, ${largeDuration.toFixed(1)}ms for one equally sized parse`,
    );

    const tree = parser.parse(largeSource);
    const records = tree.rootNode.descendantsOfType("dynamic_record");
    assert.strictEqual(records.length, smallRecordCount * scale);
    assert.strictEqual(records[0].childForFieldName("name").text, "CMD0000");
    assert.strictEqual(records.at(-1).childForFieldName("name").text, "CMD2047");
    assert.strictEqual(tree.rootNode.descendantsOfType("string").length, smallRecordCount * scale);
  },
);

test("exposes END and ENDE as control keywords", () => {
  const tree = parse("+PROG AQUA\nEND\nHEAD Again\nENDE");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("control_keyword").map((node) => node.text),
    ["END", "ENDE"],
  );
});

test("keeps a root program boundary after a mojibake BOM", () => {
  const tree = parse("+PROG AQUA\nHEAD A\nï»¿PROG ASE\nEND");
  assert.strictEqual(tree.rootNode.hasError, true);
  const programs = tree.rootNode.descendantsOfType("program");
  assert.strictEqual(programs.length, 2);
  assert.strictEqual(
    programs[1].childForFieldName("header").childForFieldName("module").text,
    "ASE",
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

test("exposes quoted strings inside generators and parenthesized values", () => {
  const tree = parse("+PROG AQUA\nHEAD ('PP') (\"A B\" #INDEX $(OFFSET))\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("string").map((node) => node.text),
    ["'PP'", '"A B"'],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("hash_variable").map((node) => node.text),
    ["#INDEX"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(OFFSET)"],
  );
});

test("exposes variables in parenthesized expressions without claiming them as generators", () => {
  const tree = parse("+PROG AQUA\nHEAD (#L_1) (D) (#L_1)+(#L_2-#L_1+#L_0)*(#i/(#L_n-1))\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("sequence_generator").length, 0);
  assert.strictEqual(tree.rootNode.descendantsOfType("generator_literal").length, 0);
  assert.strictEqual(tree.rootNode.descendantsOfType("parenthesized_expression").length, 5);
  assert.strictEqual(tree.rootNode.descendantsOfType("generic_expression")[0].text, "(D)");
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("hash_variable").map((node) => node.text),
    ["#L_1", "#L_1", "#L_2", "#L_1", "#L_0", "#i", "#L_n"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("number").length, 0);
});

test("exposes every variable in LET calculations containing parentheses", () => {
  const tree = parse(
    "+PROG SOFILOAD\n" +
      "LET#D_1 1.2+0.40+#D_F ; LET#POS #L_1+#D_1+(#L_2-#L_1-#D_1)*(#I/(#L_N-1))\n" +
      "END",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  const statement = tree.rootNode.descendantsOfType("variable_statement")[1];
  assert.deepStrictEqual(
    statement.descendantsOfType("hash_variable").map((node) => node.text),
    ["#POS", "#L_1", "#D_1", "#L_2", "#L_1", "#D_1", "#I", "#L_N"],
  );
  assert.strictEqual(statement.descendantsOfType("generic_expression").length, 0);
});

test("keeps formatted hash expressions valid while exposing embedded variables", () => {
  const tree = parse("+PROG AQUA\nTXE #(#lc,8.0) (#(Y+0))*#yscal 1.51*(#p_z3+0.36)\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("hash_variable").map((node) => node.text),
    ["#lc", "#yscal", "#p_z3"],
  );
});

test("separates both variable syntaxes and quoted strings in LET definitions", () => {
  const tree = parse("+PROG SOFILOAD\nLET#OUT #INPUT+$(OFFSET) \"double\" 'single'\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  const statement = tree.rootNode.descendantsOfType("variable_statement")[0];
  assert.deepStrictEqual(
    statement.descendantsOfType("hash_variable").map((node) => node.text),
    ["#OUT", "#INPUT"],
  );
  assert.deepStrictEqual(
    statement.descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(OFFSET)"],
  );
  assert.deepStrictEqual(
    statement.descendantsOfType("string").map((node) => node.text),
    ['"double"', "'single'"],
  );
});

test("accepts a final variable statement without a newline or semicolon", () => {
  const source = "DEL#VALUE ; STO#VALUE 16000.0";
  const tree = parse(source);
  assert.strictEqual(tree.rootNode.hasError, false);
  const statements = tree.rootNode.descendantsOfType("variable_statement");
  assert.strictEqual(statements.length, 2);
  assert.deepStrictEqual(
    statements.map((statement) => statement.childForFieldName("keyword").text),
    ["DEL", "STO"],
  );
  assert.strictEqual(statements.at(-1).endIndex, source.length);
});

test("exposes dollar variables but keeps hash syntax inside quoted strings", () => {
  const tree = parse(
    "+PROG AQUA\n" +
      'HEAD "double ""quoted"" $(asetxt1) #DOUBLE ! ; PROG" ' +
      "'single ''quoted'' $(asetxt2) #SINGLE ! ; PROG'\n" +
      "END",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  const strings = tree.rootNode.descendantsOfType("string");
  assert.strictEqual(strings.length, 2);
  assert.deepStrictEqual(
    strings[0].descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(asetxt1)"],
  );
  assert.strictEqual(strings[0].descendantsOfType("hash_variable").length, 0);
  assert.deepStrictEqual(
    strings[1].descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(asetxt2)"],
  );
  assert.strictEqual(strings[1].descendantsOfType("hash_variable").length, 0);
  assert.strictEqual(tree.rootNode.descendantsOfType("comment").length, 0);
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

test("keeps variable-only block DEFINE bodies in the transparent module tail", () => {
  const source =
    "+PROG TEMPLATE\nEND\n#DEFINE VALUES\n$(FIRST)\n$(SECOND)\n#ENDDEF\n\n" +
    "+PROG SOFILOAD URS:2\nEND";
  const tree = parse(source);
  assert.strictEqual(tree.rootNode.hasError, false);

  const programs = tree.rootNode.descendantsOfType("program");
  const nextProgramStart = source.indexOf("+PROG SOFILOAD");
  assert.strictEqual(programs.length, 2);
  assert.strictEqual(programs[0].endIndex, nextProgramStart);
  assert.strictEqual(programs[0].childrenForFieldName("body").length, 1);
  assert.deepStrictEqual(
    programs[0].descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(FIRST)", "$(SECOND)"],
  );
  const expansions = programs[0]
    .childrenForFieldName("tail")
    .filter((node) => node.type === "implicit_record");
  assert.strictEqual(expansions.length, 2);
  assert.ok(expansions.every((record) => record.descendantsOfType("dollar_variable").length === 1));
});

test("keeps a single-line DEFINE value neutral while exposing variables", () => {
  const tree = parse("#define p_poin = poin qgrp 'PP' type pg p #Q_w x #x y #y");
  assert.strictEqual(tree.rootNode.hasError, false);
  const statement = tree.rootNode.descendantsOfType("preprocessor_define_statement")[0];
  const value = statement.childForFieldName("value");
  assert.strictEqual(value.type, "preprocessor_value");
  assert.strictEqual(value.text, "= poin qgrp 'PP' type pg p #Q_w x #x y #y");
  assert.deepStrictEqual(
    value.namedChildren
      .filter((node) => node.type === "hash_variable" || node.type === "dollar_variable")
      .map((node) => [node.type, node.text]),
    [
      ["hash_variable", "#Q_w"],
      ["hash_variable", "#x"],
      ["hash_variable", "#y"],
    ],
  );
  assert.deepStrictEqual(
    value.descendantsOfType("string").map((node) => node.text),
    ["'PP'"],
  );
  assert.strictEqual(statement.descendantsOfType("expression").length, 0);
});

test("keeps malformed hash prose recovery to its original error range", () => {
  const tree = parse("-prog template urs:13\nhead # CDB_IER=1 - Usage for Support Forces\nend");
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("ERROR").map((node) => node.text),
    ["# CDB_IER=1 - Usage for Support Forces", "#"],
  );
});

test("ends a neutral DEFINE value before inline comments", () => {
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
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(no)"],
  );
});

test("exposes substitutions on the right side of linear DEFINE statements", () => {
  const tree = parse(
    "#define probase = [c] main\n#define project = $(probase)\n#define load = #Q_w+#x",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  const values = tree.rootNode.descendantsOfType("preprocessor_value");
  assert.deepStrictEqual(
    values.map((value) =>
      value.namedChildren
        .filter((node) => node.type === "hash_variable" || node.type === "dollar_variable")
        .map((node) => [node.type, node.text]),
    ),
    [
      [],
      [["dollar_variable", "$(probase)"]],
      [
        ["hash_variable", "#Q_w"],
        ["hash_variable", "#x"],
      ],
    ],
  );
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
    ["preprocessor_if_header", "program", "program", "sys_statement", "preprocessor_endif_record"],
  );
  const programs = tree.rootNode.descendantsOfType("program");
  assert.strictEqual(
    tree.rootNode.descendantsOfType("preprocessor_elseif_header")[0].parent.id,
    programs[0].id,
  );
  assert.strictEqual(
    tree.rootNode.descendantsOfType("preprocessor_else_header")[0].parent.id,
    programs[1].id,
  );

  const conditions = tree.rootNode.descendantsOfType("preprocessor_condition");
  assert.deepStrictEqual(
    conditions.map((node) => node.text.trimStart()),
    ["#version >= 2024 & (#enabled)", "#version = 2023"],
  );
  assert.deepStrictEqual(
    conditions.map((node) =>
      node.namedChildren
        .filter((child) => child.type === "hash_variable" || child.type === "dollar_variable")
        .map((child) => [child.type, child.text]),
    ),
    [
      [
        ["hash_variable", "#version"],
        ["hash_variable", "#enabled"],
      ],
      [["hash_variable", "#version"]],
    ],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("expression").length, 0);
});

test("keeps conditional text neutral while exposing dollar and hash variables", () => {
  const tree = parse(
    "#if $(project)<>$(probase) & \"active\"\n#elseif #condition + 'fallback' ! explanation\n#endif",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(project)", "$(probase)"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("hash_variable").map((node) => node.text),
    ["#condition"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("comment").map((node) => node.text),
    ["! explanation"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("string").map((node) => node.text),
    ['"active"', "'fallback'"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("expression").length, 0);
  assert.strictEqual(tree.rootNode.descendantsOfType("number").length, 0);
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
  assert.strictEqual(tree.rootNode.descendantsOfType("commented_program_scope").length, 2);
  assert.strictEqual(tree.rootNode.descendantsOfType("program").length, 1);
  assert.strictEqual(tree.rootNode.descendantsOfType("command_name")[0].text, "supp");
});

test("keeps a real program open through its transparent module tail", () => {
  const source = "+PROG AQB\nEND\n#DEFINE aqblcs\nLC 1\nLC 2\nLC 3\n#ENDDEF\nPROG AQUA\nEND";
  const tree = parse(source);
  assert.strictEqual(tree.rootNode.hasError, false);

  const programs = tree.rootNode.descendantsOfType("program");
  const nextProgramStart = source.indexOf("PROG AQUA");
  assert.strictEqual(programs.length, 2);
  assert.strictEqual(programs[0].startIndex, 0);
  assert.strictEqual(programs[0].endIndex, nextProgramStart);
  assert.strictEqual(programs[1].startIndex, nextProgramStart);
  assert.deepStrictEqual(
    programs[0].childrenForFieldName("tail").map((node) => node.type),
    ["preprocessor_define_header", "command", "command", "command", "preprocessor_enddef_record"],
  );
  assert.deepStrictEqual(
    programs[0].descendantsOfType("command_name").map((node) => node.text),
    ["LC", "LC", "LC"],
  );
});

test("groups dollar PROG tails into stable commented scopes", () => {
  const source =
    "$PROG ASE\n#DEFINE ASE_CTRL\nPAGE UNII 0\n#ENDDEF\n" +
    "$PROG AQB\n#DEFINE AQB_CTRL\nPAGE UNII 0\n#ENDDEF";
  const tree = parse(source);
  assert.strictEqual(tree.rootNode.hasError, false);

  const scopes = tree.rootNode.descendantsOfType("commented_program_scope");
  const secondScopeStart = source.indexOf("$PROG AQB");
  assert.strictEqual(scopes.length, 2);
  assert.strictEqual(scopes[0].startIndex, 0);
  assert.strictEqual(scopes[0].endIndex, secondScopeStart);
  assert.strictEqual(scopes[1].startIndex, secondScopeStart);
  assert.strictEqual(scopes[1].endIndex, source.length);
  assert.deepStrictEqual(
    scopes.map((scope) => scope.childForFieldName("header").type),
    ["commented_program_header", "commented_program_header"],
  );
  assert.deepStrictEqual(
    scopes.map((scope) => scope.descendantsOfType("command_name").map((node) => node.text)),
    [["PAGE"], ["PAGE"]],
  );
});

test("ends module scopes before dollar PROG, APPLY, and SYS statements", () => {
  const source =
    "+PROG AQUA\nEND\nDescription\n" +
    "$PROG AQB\n#DEFINE AQB_CTRL\nPAGE UNII 0\n#ENDDEF\n" +
    "APPLY first.dat\nSYS echo done";
  const tree = parse(source);
  assert.strictEqual(tree.rootNode.hasError, false);

  const program = tree.rootNode.descendantsOfType("program")[0];
  const commentedScope = tree.rootNode.descendantsOfType("commented_program_scope")[0];
  assert.strictEqual(program.endIndex, source.indexOf("$PROG"));
  assert.strictEqual(commentedScope.endIndex, source.indexOf("APPLY"));
  assert.strictEqual(tree.rootNode.descendantsOfType("apply_statement").length, 1);
  assert.strictEqual(tree.rootNode.descendantsOfType("sys_statement").length, 1);
});

test("accepts descriptive text between program scopes", () => {
  const tree = parse(
    "11 Belki prefabrykowane\n-0.1250 20.0000 21.0000\n+0.1250 35.0000 81.0000\n21 Poprzecznice podporowe\n+PROG AQUA\nEND\nDescription after a module",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("ignored_text").map((node) => node.text.trim()),
    [
      "11 Belki prefabrykowane",
      "-0.1250 20.0000 21.0000",
      "+0.1250 35.0000 81.0000",
      "21 Poprzecznice podporowe",
      "Description after a module",
    ],
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

test("uses executable module aliases with their schema vocabularies", () => {
  const tree = parse(
    "+PROG DBMERG\nHEAD Copy results\nCDB FROM 1\nEND\n" +
      "+PROG STAR2\nBEME AM1 1\nEND\n" +
      "+PROG TUNARS\nGEO NO 1\nEND",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("module_name").map((node) => node.text),
    ["DBMERG", "STAR2", "TUNARS"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("command_name").map((node) => node.text),
    ["HEAD", "CDB", "BEME", "GEO"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("item_name").map((node) => node.text),
    ["FROM", "AM1", "NO"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("invalid_module").length, 0);
  assert.strictEqual(tree.rootNode.descendantsOfType("invalid_command").length, 0);
});

test("inherits localized PAGE commands from BASIC in every program scope", () => {
  const tree = parse(
    "$PROG ASE\n#DEFINE ASE_CTRL\nPAGE UNII 0\n#ENDDEF\n" +
      "$PROG AQB\n#DEFINE AQB_CTRL\nSEIT UNIE 0\n#ENDDEF",
  );

  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("command_name").map((node) => node.text),
    ["PAGE", "SEIT"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("item_name").map((node) => node.text),
    ["UNII", "UNIE"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("invalid_command").length, 0);
});

test("prefers a module command override before the BASIC fallback", () => {
  const tree = parse("+PROG AQB\nCTRL VAL4 1 VAL5 2\nEND\n+PROG ASE\nPAGE UNII 0\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("command_name").map((node) => node.text),
    ["CTRL", "PAGE"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("item_name").map((node) => node.text),
    ["VAL4", "UNII"],
  );
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

test("separates comma-delimited substitutions without hiding later variables", () => {
  const tree = parse("+PROG MAXIMA\nACT $(actqs),$(roads),$(third)\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(actqs)", "$(roads)", "$(third)"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("bare_value").map((node) => node.text),
    [",", ","],
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

test("keeps text syntax opaque while exposing variables and strings", () => {
  const tree = parse(
    "+PROG AQUA\nHEAD 'a; $ PROG'\n<TEXT,FILE=+#outfile,PATH=$(folder),TITLE='PP'>\nPROG not parsed; $ not comment\nnatural it's #after\n' unmatched #later\n\" unmatched $(later)\n#title $(project) \"double\" 'single'\n<\\TEXT>\nEND",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.strictEqual(tree.rootNode.descendantsOfType("string")[0].text, "'a; $ PROG'");
  assert.match(tree.rootNode.descendantsOfType("text_content")[0].text, /PROG not parsed/);
  const textBlock = tree.rootNode.descendantsOfType("text_block")[0];
  assert.deepStrictEqual(
    textBlock.descendantsOfType("hash_variable").map((node) => node.text),
    ["#outfile", "#after", "#later", "#title"],
  );
  assert.deepStrictEqual(
    textBlock.descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(folder)", "$(later)", "$(project)"],
  );
  assert.deepStrictEqual(
    textBlock.descendantsOfType("string").map((node) => node.text),
    ["'PP'", '"double"', "'single'"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("comment").length, 0);
});

test("keeps quoted and variable assignment values outside the equals token", () => {
  const tree = parse(
    "+PROG AQUA\nHEAD TITL=\"Sum_11 G1 activating new\" TITS='single quoted' HASH=#title DOLLAR=$(project)\nEND",
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("expression").map((node) => node.text),
    ["=", "=", "=", "="],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("string").map((node) => node.text),
    ['"Sum_11 G1 activating new"', "'single quoted'"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("hash_variable").map((node) => node.text),
    ["#title"],
  );
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(project)"],
  );
});

test("accepts include names while preserving the current command", () => {
  const tree = parse("+PROG SOFIMSHA\nNODE 1 X 0\n#INCLUDE blockase\nX 2 Y 0\nEND");
  assert.strictEqual(tree.rootNode.hasError, false);
  const directive = tree.rootNode.descendantsOfType("preprocessor_directive")[0];
  assert.strictEqual(directive.childForFieldName("argument").text, "blockase");
  assert.strictEqual(tree.rootNode.descendantsOfType("implicit_record").length, 1);
});

test("keeps every INCLUDE argument inside its directive", () => {
  const tree = parse(
    '#INCLUDE maxima-supp\n#INCLUDE "$(project).dat"\n#INCLUDE $(project)\n#INCLUDE #i_results\n#UNDEF #temporary',
  );
  assert.strictEqual(tree.rootNode.hasError, false);
  const directives = tree.rootNode.descendantsOfType("preprocessor_directive");
  assert.deepStrictEqual(
    directives.map((directive) => {
      const argument = directive.childForFieldName("argument");
      return [argument.type, argument.text];
    }),
    [
      ["bare_value", "maxima-supp"],
      ["string", '"$(project).dat"'],
      ["dollar_variable", "$(project)"],
      ["hash_variable", "#i_results"],
      ["preprocessor_name", "#temporary"],
    ],
  );
});

test("starts each known command on a new root-scope line", () => {
  const tree = parse("+PROG AQB\nEND\n#DEFINE aqblcs\nLC 1\n  LC 2\nLC 3\n#ENDDEF");
  assert.strictEqual(tree.rootNode.hasError, false);
  assert.deepStrictEqual(
    tree.rootNode.descendantsOfType("command_name").map((node) => node.text.toUpperCase()),
    ["LC", "LC", "LC"],
  );
  assert.strictEqual(tree.rootNode.descendantsOfType("implicit_record").length, 0);
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
  const fresh = parser.parse(changed);
  assert.strictEqual(reparsed.rootNode.hasError, false);
  assert.strictEqual(reparsed.rootNode.toString(), fresh.rootNode.toString());
  assert.deepStrictEqual(
    reparsed.rootNode.descendantsOfType("item_name").map((node) => node.text),
    ["X", "Y"],
  );
});

test("restores TEXT scanner state during an incremental reparse", () => {
  const parser = new Parser();
  parser.setLanguage(SOFiSTiK);
  const source = "+PROG AQUA\n<TEXT,FILE=#path>\nvalue #OLD $(NAME)\n</TEXT>\nEND";
  const changed = "+PROG AQUA\n<TEXT,FILE=#path>\nvalue #NEW $(NAME)\n</TEXT>\nEND";
  const tree = parser.parse(source);
  const index = source.indexOf("OLD");
  const point = { row: 2, column: source.slice(source.lastIndexOf("\n", index) + 1, index).length };
  tree.edit({
    startIndex: index,
    oldEndIndex: index + 3,
    newEndIndex: index + 3,
    startPosition: point,
    oldEndPosition: { row: point.row, column: point.column + 3 },
    newEndPosition: { row: point.row, column: point.column + 3 },
  });

  const reparsed = parser.parse(changed, tree);
  const fresh = parser.parse(changed);
  assert.strictEqual(reparsed.rootNode.hasError, false);
  assert.strictEqual(reparsed.rootNode.toString(), fresh.rootNode.toString());
  assert.deepStrictEqual(
    reparsed.rootNode.descendantsOfType("hash_variable").map((node) => node.text),
    ["#path", "#NEW"],
  );
  assert.deepStrictEqual(
    reparsed.rootNode.descendantsOfType("dollar_variable").map((node) => node.text),
    ["$(NAME)"],
  );
});
