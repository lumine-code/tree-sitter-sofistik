const assert = require("node:assert/strict");

function pointAt(source, index) {
  const prefix = source.slice(0, index);
  return { row: prefix.split("\n").length - 1, column: index - prefix.lastIndexOf("\n") - 1 };
}

function editTree(tree, before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  tree.edit({
    startIndex: start,
    oldEndIndex: oldEnd,
    newEndIndex: newEnd,
    startPosition: pointAt(before, start),
    oldEndPosition: pointAt(before, oldEnd),
    newEndPosition: pointAt(after, newEnd),
  });
}

function snapshot(node) {
  return [node.type, node.startIndex, node.endIndex, node.children.map(snapshot)];
}

function texts(tree, type) {
  return tree.rootNode.descendantsOfType(type).map((node) => node.text);
}

function release(...resources) {
  for (const resource of resources) resource?.delete?.();
}

function isLog(message, event) {
  return message === event || message.startsWith(`${event} `);
}

function registerParserRegressions(test, createParser) {
  test("keeps include-fragment comments visible without an initial module", () => {
    const parser = createParser();
    try {
      for (const newline of ["\n", "\r\n"]) {
        for (const finalNewline of ["", newline]) {
          const source =
            ["del#n2s ; sto#n2s 0 $$", "0 $$", "0 $$", "0 $$"].join(newline) + finalNewline;
          const tree = parser.parse(source);
          try {
            assert.equal(tree.rootNode.hasError, false, source);
            assert.deepEqual(texts(tree, "module_name"), []);
            assert.deepEqual(texts(tree, "command_name"), []);
            assert.deepEqual(texts(tree, "variable_keyword"), ["del", "sto"]);
            assert.deepEqual(texts(tree, "ignored_text"), []);
            const markers = tree.rootNode.descendantsOfType(["comment", "continuation"]);
            assert.deepEqual(
              markers.map((node) => node.text),
              ["$$", "$$", "$$", "$$"],
            );
            assert.deepEqual(
              markers.map((node) => node.startPosition.row),
              [0, 1, 2, 3],
            );
          } finally {
            release(tree);
          }
        }
      }
      const source =
        "plain $ comment\nplain ! comment\nplain // comment\n" +
        "plain '$$ ! // literal' $ outside\n";
      const tree = parser.parse(source);
      try {
        assert.equal(tree.rootNode.hasError, false);
        assert.deepEqual(texts(tree, "comment"), [
          "$ comment",
          "! comment",
          "// comment",
          "$ outside",
        ]);
        assert.deepEqual(texts(tree, "continuation"), []);
        assert.deepEqual(texts(tree, "string"), ["'$$ ! // literal'"]);
      } finally {
        release(tree);
      }
      for (const source of [
        "plain $(missing",
        "plain $()",
        "plain $(",
        "plain $() $ outside",
        "plain $() // outside",
        "plain $() $$",
      ]) {
        const tree = parser.parse(source);
        try {
          assert.equal(tree.rootNode.hasError, false);
          assert.deepEqual(texts(tree, "ignored_text"), [source]);
          assert.deepEqual(texts(tree, "comment"), []);
        } finally {
          release(tree);
        }
      }
    } finally {
      release(parser);
    }
  });

  test("updates unscoped continuation markers incrementally", () => {
    const parser = createParser();
    let source = "del#n2s ; sto#n2s 0 $$\n0 $$\n0 $$\n0 $$\n";
    let tree = parser.parse(source);
    try {
      for (const nextSource of [
        source.replace("0 $$\n0 $$", "0\n0 $$"),
        source.replaceAll("$$", "$ comment"),
        source,
        source.slice(0, -1),
        source,
      ]) {
        editTree(tree, source, nextSource);
        const incremental = parser.parse(nextSource, tree);
        const fresh = parser.parse(nextSource);
        try {
          assert.equal(incremental.rootNode.hasError, false);
          assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode));
          assert.deepEqual(texts(incremental, "comment"), texts(fresh, "comment"));
          assert.deepEqual(texts(incremental, "continuation"), texts(fresh, "continuation"));
        } finally {
          release(fresh);
        }
        release(tree);
        tree = incremental;
        source = nextSource;
      }
    } finally {
      release(tree, parser);
    }
  });

  test("keeps incomplete substitutions within physical quoted string boundaries", () => {
    const parser = createParser();
    try {
      for (const quote of ["'", '"']) {
        for (const literal of ["$(", "$(missing", "$()", `$(name${quote}${quote}tail`]) {
          const value = `${quote}cost ${literal}${quote}`;
          const after = `${quote}after${quote}`;
          for (const ending of ["\nEND\n", "\nEND", ""]) {
            const source = `+PROG AQUA\nHEAD ${value} outside 7 (1) ${after}${ending}`;
            const tree = parser.parse(source);
            try {
              assert.equal(tree.rootNode.hasError, false, source);
              assert.deepEqual(texts(tree, "string"), [value, after], source);
              assert.deepEqual(texts(tree, "dollar_variable"), [], source);
              assert.deepEqual(texts(tree, "bare_value"), ["outside"], source);
              assert.deepEqual(texts(tree, "number"), ["7"], source);
              assert.deepEqual(texts(tree, "parenthesized_expression"), ["(1)"], source);
              const string = tree.rootNode.descendantsOfType("string")[0];
              assert.deepEqual(string.startPosition, { row: 1, column: 5 });
              assert.deepEqual(string.endPosition, { row: 1, column: 5 + value.length });
              assert.equal(texts(tree, "unterminated_string").length, 0, source);
            } finally {
              release(tree);
            }
          }
        }
      }
    } finally {
      release(parser);
    }
  });

  test("preserves quoted substitutions and doubled escapes in both quote styles", () => {
    const parser = createParser();
    try {
      for (const quote of ["'", '"']) {
        const other = quote === "'" ? '"' : "'";
        for (const substitution of [
          "$(NAME)",
          `$(name${quote}${quote}tail)`,
          `$(name${other}tail)`,
        ]) {
          const value = `${quote}prefix ${quote}${quote}quoted${quote}${quote} ${substitution}${quote}`;
          const tree = parser.parse(`+PROG AQUA\nHEAD ${value} outside\nEND\n`);
          try {
            assert.equal(tree.rootNode.hasError, false, value);
            assert.deepEqual(texts(tree, "string"), [value], value);
            assert.deepEqual(texts(tree, "dollar_variable"), [substitution], value);
            assert.deepEqual(texts(tree, "bare_value"), ["outside"], value);
          } finally {
            release(tree);
          }
        }
        const incomplete = `${quote}prefix ${quote}${quote}quoted${quote}${quote} $(missing${quote}`;
        const tree = parser.parse(`+PROG AQUA\nHEAD ${incomplete} outside\nEND\n`);
        try {
          assert.equal(tree.rootNode.hasError, false);
          assert.deepEqual(texts(tree, "string"), [incomplete]);
          assert.deepEqual(texts(tree, "bare_value"), ["outside"]);
        } finally {
          release(tree);
        }
      }
    } finally {
      release(parser);
    }
  });

  test("preserves incomplete quoted substitutions inside other record surfaces", () => {
    const parser = createParser();
    try {
      for (const quote of ["'", '"']) {
        const value = `${quote}cost $(missing${quote}`;
        for (const source of [
          `+PROG AQUA\nHEAD (1 ${value}) outside\nEND\n`,
          `+PROG AQUA\n<TEXT,TITLE=${value}>\nbody\n</TEXT>\nEND\n`,
          `#define message = ${value} outside\n`,
        ]) {
          const tree = parser.parse(source);
          try {
            assert.equal(tree.rootNode.hasError, false, source);
            assert.deepEqual(texts(tree, "string"), [value], source);
            assert.deepEqual(texts(tree, "dollar_variable"), [], source);
          } finally {
            release(tree);
          }
        }
        const unterminated = parser.parse(`+PROG AQUA\nHEAD ${quote}cost $(missing\nEND\n`);
        try {
          assert.equal(unterminated.rootNode.hasError, false);
          assert.equal(texts(unterminated, "unterminated_string").length, 1);
        } finally {
          release(unterminated);
        }
      }
    } finally {
      release(parser);
    }
  });

  test("matches quoted substitution boundaries after incremental delimiter and argument edits", () => {
    const parser = createParser();
    try {
      for (const quote of ["'", '"']) {
        const before = `+PROG AQUA\nHEAD ${quote}prefix $(NAME)${quote} outside (1)\nEND\n`;
        const alternatives = [
          before.replace("$(NAME)", "$(NAME"),
          before.replace("$(NAME)", "$("),
          before.replace("$(NAME)", `$(NAME${quote}${quote}tail)`),
          before.replace("$(NAME)", `$(NAME${quote}${quote}tail`),
          before.replace("$(NAME)", "$(NAME").replace("(1)", "(2)"),
          before.replace("outside (1)", `${quote}next $(PARTIAL${quote} (2)`),
        ];
        for (const changed of alternatives) {
          for (const [original, updated] of [
            [before, changed],
            [changed, before],
          ]) {
            const old = parser.parse(original);
            let incremental, fresh;
            try {
              editTree(old, original, updated);
              incremental = parser.parse(updated, old);
              fresh = parser.parse(updated);
              assert.equal(fresh.rootNode.hasError, false, updated);
              assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode), updated);
            } finally {
              release(old, incremental, fresh);
            }
          }
        }
      }
    } finally {
      release(parser);
    }
  });

  test("bounds lexical work for repeated incomplete substitutions inside quoted strings", (t) => {
    const parser = createParser();
    try {
      for (const quote of ["'", '"']) {
        for (const count of [128, 512]) {
          const value = `${quote}${"$( ".repeat(count)}${quote}`;
          const source = `+PROG AQUA\nHEAD ${value} outside (1)\nEND\n`;
          let consumed = 0;
          parser.setLogger((message) => {
            if (isLog(message, "consume")) consumed++;
          });
          let tree;
          try {
            tree = parser.parse(source);
            assert.equal(tree.rootNode.hasError, false);
          } finally {
            parser.setLogger(null);
          }
          try {
            assert.deepEqual(texts(tree, "string"), [value]);
            assert.deepEqual(texts(tree, "dollar_variable"), []);
            assert.deepEqual(texts(tree, "bare_value"), ["outside"]);
            assert.ok(
              consumed < source.length * 8,
              `${consumed} lexer advances for ${source.length} characters`,
            );
            t.diagnostic(
              `${quote} ${count} incomplete substitutions: ${consumed} lexer advances/${source.length} characters`,
            );
          } finally {
            release(tree);
          }
        }
      }
    } finally {
      parser.setLogger(null);
      release(parser);
    }
  });

  test("separates schema DEL commands from attached variable deletions", () => {
    const parser = createParser();
    try {
      for (const command of ["QUAD", "NODE"]) {
        for (const prefix of ["", "END\n"]) {
          const source = `+PROG SOFIMSHA\n${prefix}${command} NO 1\nDEL QUAD 1 2 GRP\nDEL#temporary\n${command} NO 2\nEND\n`;
          const tree = parser.parse(source);
          try {
            assert.equal(tree.rootNode.hasError, false, source);
            assert.deepEqual(texts(tree, "command_name"), [command, "DEL", command]);
            assert.deepEqual(texts(tree, "variable_keyword"), ["DEL"]);
            assert.deepEqual(texts(tree, "hash_variable_name"), ["#temporary"]);
          } finally {
            release(tree);
          }
          const updated = source.replace("DEL QUAD 1 2 GRP", "DEL BRIC 11 13 GRP");
          for (const [before, after] of [
            [source, updated],
            [updated, source],
          ]) {
            const original = parser.parse(before);
            let incremental, fresh;
            try {
              editTree(original, before, after);
              incremental = parser.parse(after, original);
              fresh = parser.parse(after);
              assert.equal(fresh.rootNode.hasError, false, after);
              assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode));
            } finally {
              release(original, incremental, fresh);
            }
          }
        }
      }
    } finally {
      release(parser);
    }
  });

  test("ends tables before scalar and block DEFINE headers without losing their module", () => {
    const parser = createParser();
    try {
      for (const prefix of ["", "END\n"]) {
        const before = `+PROG SOFIMSHA\n${prefix}NODE NO X Y Z\n1 0 0 0\n#define scale=1\n#define nodes\nNODE 2 X $(scale)\n#enddef\nEND\n`;
        const updated = before.replace("#define scale=1", "#define scale=2 ! changed");
        for (const source of [before, updated]) {
          const tree = parser.parse(source);
          try {
            assert.equal(tree.rootNode.hasError, false, source);
            assert.deepEqual(texts(tree, "command_name"), ["NODE", "NODE"]);
            assert.equal(texts(tree, "table_definition").length, 1);
            assert.equal(texts(tree, "table_row").length, 1);
            assert.equal(texts(tree, "preprocessor_define_statement").length, 1);
            assert.equal(texts(tree, "preprocessor_define_header").length, 1);
            assert.deepEqual(texts(tree, "preprocessor_name"), ["scale", "nodes"]);
            assert.deepEqual(texts(tree, "ignored_text"), []);
          } finally {
            release(tree);
          }
        }
        for (const [original, after] of [
          [before, updated],
          [updated, before],
        ]) {
          const tree = parser.parse(original);
          let incremental, fresh;
          try {
            editTree(tree, original, after);
            incremental = parser.parse(after, tree);
            fresh = parser.parse(after);
            assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode));
          } finally {
            release(tree, incremental, fresh);
          }
        }
      }
    } finally {
      release(parser);
    }
  });

  test("ends tables before attached and separated variable statements", () => {
    const parser = createParser();
    try {
      for (const keyword of ["STO", "LET", "RCL", "DEL", "DBG", "PRT"]) {
        for (const spelling of [
          keyword,
          keyword.toLowerCase(),
          keyword[0] + keyword.slice(1).toLowerCase(),
        ]) {
          for (const spacing of ["", " ", "\t"]) {
            const statement = `${spelling}${spacing}#value 0.21 ! setup`;
            const before = `+PROG SOFILOAD\nACT TYPE PART SUP GAMU\nlp_u q_1 cond 1.35\n${statement}\nACT TYPE PART SUP GAMU\nlp_x q_1 unsi 1.35\nLC 1\nEND\n`;
            const after = before.replace("#value 0.21", "#other -1.175");
            for (const source of [before, after]) {
              const tree = parser.parse(source);
              try {
                assert.equal(tree.rootNode.hasError, false, source);
                assert.deepEqual(texts(tree, "variable_keyword"), [spelling], source);
                assert.equal(texts(tree, "variable_statement").length, 1, source);
                assert.equal(texts(tree, "table_row").length, 2, source);
                assert.deepEqual(texts(tree, "command_name"), ["ACT", "ACT", "LC"], source);
                assert.equal(texts(tree, "table_definition").length, 2, source);
                const variable = tree.rootNode.descendantsOfType("variable_statement")[0];
                assert.equal(variable.parent.type, "input_block", source);
              } finally {
                release(tree);
              }
            }
            const original = parser.parse(before);
            let incremental, fresh;
            try {
              editTree(original, before, after);
              incremental = parser.parse(after, original);
              fresh = parser.parse(after);
              assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode), statement);
            } finally {
              release(original, incremental, fresh);
            }
          }
        }
      }
    } finally {
      release(parser);
    }
  });

  test("inserting and removing a variable statement invalidates the following table rows", () => {
    const parser = createParser();
    const before = "+PROG SOFILOAD\nACT TYPE PART SUP\nlp_u q_1 cond\nlp_x q_1 unsi\nLC 1\nEND\n";
    const after = before.replace("lp_x", "STO #value 1\nlp_x");
    try {
      for (const [original, updated, rows] of [
        [before, after, 1],
        [after, before, 2],
      ]) {
        const tree = parser.parse(original);
        let incremental, fresh;
        try {
          editTree(tree, original, updated);
          incremental = parser.parse(updated, tree);
          fresh = parser.parse(updated);
          assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode));
          assert.equal(texts(fresh, "table_row").length, rows);
          assert.deepEqual(texts(fresh, "ERROR"), rows === 1 ? ["lp_x q_1 unsi"] : []);
          assert.deepEqual(texts(fresh, "command_name"), ["ACT", "LC"]);
          for (const variable of fresh.rootNode.descendantsOfType("variable_statement")) {
            assert.equal(variable.parent.type, "input_block");
          }
        } finally {
          release(tree, incremental, fresh);
        }
      }
    } finally {
      release(parser);
    }
  });

  test("keeps variable-like table cells as data around structured statements", () => {
    const parser = createParser();
    try {
      for (const boundary of [
        "LOOP#i 2\nENDLOOP",
        "IF 1\nENDIF",
        "#DEFINE value=1",
        "#INCLUDE model",
        "#UNDEF model",
        "@KEY 1",
        "LC 1",
      ]) {
        const source = `+PROG SOFILOAD\nACT TYPE PART SUP GAMU\nSTO q_1 cond 1.35\nLET q_1 unsi 1.35\nsto 'title' cond 1.35\n${boundary}\nEND\n`;
        const tree = parser.parse(source);
        try {
          assert.equal(tree.rootNode.hasError, false, source);
          assert.equal(texts(tree, "table_row").length, 3, source);
          assert.deepEqual(texts(tree, "variable_statement"), [], source);
          assert.ok(texts(tree, "bare_value").includes("STO"), source);
          assert.ok(texts(tree, "bare_value").includes("LET"), source);
          assert.ok(texts(tree, "bare_value").includes("sto"), source);
        } finally {
          release(tree);
        }
      }
    } finally {
      release(parser);
    }
  });

  test("keeps INCLUDE and UNDEF transparent between table rows", () => {
    const parser = createParser();
    const source =
      "+PROG SOFILOAD\nACT TYPE PART SUP\nlp_u q_1 cond\n#INCLUDE extra\n#UNDEF extra\nlp_x q_1 unsi\nEND\n";
    const tree = parser.parse(source);
    try {
      assert.equal(tree.rootNode.hasError, false);
      assert.equal(texts(tree, "table_row").length, 2);
      assert.deepEqual(texts(tree, "preprocessor_keyword"), ["#INCLUDE", "#UNDEF"]);
      assert.deepEqual(texts(tree, "command_name"), ["ACT"]);
    } finally {
      release(tree, parser);
    }
  });

  test("only a standalone variable statement ends a table", () => {
    const parser = createParser();
    const source =
      "+PROG SOFILOAD\nACT TYPE PART SUP\nlp_u STO #value\nLET #! no variable argument\nlp_x q_1 unsi\nEND\n";
    const tree = parser.parse(source);
    try {
      assert.equal(tree.rootNode.hasError, false);
      assert.equal(texts(tree, "table_row").length, 3);
      assert.deepEqual(texts(tree, "variable_keyword"), []);
      assert.deepEqual(texts(tree, "hash_variable_name"), ["#value"]);
    } finally {
      release(tree, parser);
    }
  });

  test("preserves ordinary Unicode characters instead of stripping partial BOMs", () => {
    const parser = createParser();
    const words = ["ïABC", "»ABC", "¿ABC", "ï»,", "ïPROG", "»PROG", "¿PROG", "µ+PROG"];
    const source = `+PROG AQUA\nHEAD ${words.join(" ")}\nEND\n`;
    const tree = parser.parse(source);
    try {
      assert.equal(tree.rootNode.hasError, false);
      assert.deepEqual(texts(tree, "bare_value"), words);
      assert.equal(tree.rootNode.descendantsOfType("program").length, 1);
      for (const marker of ["ï", "»", "¿"]) {
        const invalid = parser.parse(`+PROG ${marker}AQUA\nCONC NO 1\nEND\n`);
        try {
          assert.deepEqual(texts(invalid, "module_name"), [], marker);
          assert.ok(invalid.rootNode.hasError || texts(invalid, "invalid_module").length, marker);
        } finally {
          release(invalid);
        }
      }
    } finally {
      release(tree, parser);
    }
  });

  test("accepts complete BOMs while preserving them inside strings and TEXT", () => {
    const parser = createParser();
    try {
      for (const bom of ["\uFEFF", "ï»¿"]) {
        const tree = parser.parse(`+PROG AQUA\nHEAD A;${bom}PROG ASE\nEND\n`);
        try {
          assert.equal(tree.rootNode.hasError, false, bom);
          assert.deepEqual(texts(tree, "module_name"), ["AQUA", "ASE"], bom);
          assert.equal(texts(tree, "unterminated_input_block").length, 1, bom);
        } finally {
          release(tree);
        }
        const treeWithText = parser.parse(`+PROG AQUA\nHEAD '${bom}'\n<TEXT>${bom}</TEXT>\nEND\n`);
        try {
          assert.equal(treeWithText.rootNode.hasError, false);
          assert.deepEqual(texts(treeWithText, "string"), [`'${bom}'`]);
          assert.deepEqual(texts(treeWithText, "text_content"), [bom]);
        } finally {
          release(treeWithText);
        }
      }
    } finally {
      release(parser);
    }
  });

  test("keeps failed TEXT substitutions literal without hiding other variables or later lines", () => {
    const parser = createParser();
    const tree = parser.parse(
      "+PROG AQUA\n<TEXT>\n$( first $( #A $( #B\n$(VALID) #C\r\n$() $(NEXT)\n</TEXT>\nEND\n",
    );
    try {
      assert.equal(tree.rootNode.hasError, false);
      assert.deepEqual(texts(tree, "hash_variable_name"), ["#A", "#B", "#C"]);
      assert.deepEqual(texts(tree, "dollar_variable"), ["$(VALID)", "$(NEXT)"]);
      assert.equal(texts(tree, "text_fragment").filter((text) => text === "$").length, 4);
    } finally {
      release(tree, parser);
    }
  });

  test("invalidates failed TEXT lookahead after delimiter and line-boundary edits", () => {
    const parser = createParser();
    const before = "+PROG AQUA\n<TEXT>\n$( first $( #A\n$(VALID) #B\n</TEXT>\nEND\n";
    const alternatives = [
      before.replace("#A", "#A)"),
      before.replace("#A\n", "#A)\n"),
      before.replace("$( first $(", "$( first\n$("),
      before.replace("#A\n", "#A "),
      before.replace("$( first", "literal"),
      before.replace("$(VALID)", "$(VALID"),
      before.replace("\n$(VALID)", "\r\n$(VALID)"),
    ];
    try {
      for (const after of alternatives) {
        for (const [original, updated] of [
          [before, after],
          [after, before],
        ]) {
          const tree = parser.parse(original);
          let incremental, fresh;
          try {
            editTree(tree, original, updated);
            incremental = parser.parse(updated, tree);
            fresh = parser.parse(updated);
            assert.equal(fresh.rootNode.hasError, false, updated);
            assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode), updated);
          } finally {
            release(tree, incremental, fresh);
          }
        }
      }
    } finally {
      release(parser);
    }
  });

  test("bounds TEXT lexical work by input length for repeated failed substitutions", (t) => {
    const parser = createParser();
    try {
      for (const count of [128, 512]) {
        const source = `+PROG AQUA\n<TEXT>\n${"$( ".repeat(count)}\n</TEXT>\nEND\n`;
        let consumed = 0;
        parser.setLogger((message) => {
          if (isLog(message, "consume")) consumed++;
        });
        let tree;
        try {
          tree = parser.parse(source);
          assert.equal(tree.rootNode.hasError, false);
        } finally {
          parser.setLogger(null);
          release(tree);
        }
        assert.ok(
          consumed < source.length * 8,
          `${consumed} lexer advances for ${source.length} characters`,
        );
        t.diagnostic(
          `${count} failed substitutions: ${consumed} lexer advances/${source.length} characters`,
        );
      }
    } finally {
      parser.setLogger(null);
      release(parser);
    }
  });

  test("keeps command boundaries transparent to prose, legacy text, and auxiliary statements", () => {
    const parser = createParser();
    const cases = [
      [
        "+PROG TEMPLATE\nHEAD @NAME ; selector KWL not necessary\nUNKNOWN next line\nEND\n",
        ["HEAD"],
        ["UNKNOWN"],
      ],
      [
        "+PROG SOFIMSHA\nTXAB title\nNODE IF LOOP HEAD unknown\nTXEN\nPAGE UNII 0\nEND\n",
        ["TXAB", "TXEN", "PAGE"],
        [],
      ],
      [
        "+PROG SOFIMSHA\nEND\nNODE 1 X 0\nLET#A 1\n#include file.inc\n#define a = 1\nX 2\nIF #A\nNODE 2 X 3\nENDIF\nEND\n",
        ["NODE", "NODE"],
        [],
      ],
      [
        "+PROG AQUA\nHEAD 'text'\n  <TEXT,FILE=+#outfile,TITLE='title'>\n#body $(value)\n<\\TEXT>\nEND\n",
        ["HEAD"],
        [],
      ],
    ];
    try {
      for (const [source, commands, invalid] of cases) {
        const tree = parser.parse(source);
        try {
          assert.equal(tree.rootNode.hasError, false, source);
          assert.deepEqual(texts(tree, "command_name"), commands, source);
          assert.deepEqual(texts(tree, "invalid_command"), invalid, source);
          if (source.includes("<TEXT,")) {
            assert.equal(texts(tree, "text_block").length, 1);
            assert.deepEqual(texts(tree, "hash_variable_name"), ["#outfile", "#body"]);
          }
          if (source.includes("#include")) {
            const command = tree.rootNode.descendantsOfType("command")[0];
            assert.deepEqual(
              command.childrenForFieldName("auxiliary").map((node) => node.type),
              ["variable_statement", "preprocessor_directive", "preprocessor_define_statement"],
            );
            assert.equal(command.childrenForFieldName("record").length, 2);
          }
        } finally {
          release(tree);
        }
      }
    } finally {
      release(parser);
    }
  });

  test("matches fresh command boundaries after inserting and deleting following statements", () => {
    const parser = createParser();
    const before = "+PROG SOFIMSHA\nEND\nNODE 1 X 0\nNODE 2 X 1\nEND\n";
    const alternatives = [
      before.replace("NODE 2 X 1", "X 1"),
      before.replace("NODE 2 X 1", "IF #A\nNODE 2 X 1\nENDIF"),
      before.replace("NODE 2 X 1", "<PICT>\nNODE 2 X 1\n</PICT>"),
      before.replace("NODE 2 X 1", "<TEXT,TITLE='note'>\n#A $(B)\n</TEXT>"),
      before.replace("NODE 2 X 1", "@KEY 1 2"),
      before.replace("NODE 2 X 1", "@ note"),
      before.replace("NODE 2 X 1", "#IF $(A)\nNODE 2 X 1\n#ENDIF"),
      before.replace("NODE 2 X 1", "+PROG SOFIMSHA\nNODE 2 X 1"),
      before.replace("NODE 2 X 1", "$PROG SOFIMSHA\nNODE 2 X 1"),
      before.replace("NODE 2 X 1", "+APPLY file.inc"),
    ];
    try {
      for (const alternative of alternatives) {
        for (const [original, updated] of [
          [before, alternative],
          [alternative, before],
        ]) {
          const tree = parser.parse(original);
          let incremental, fresh;
          try {
            editTree(tree, original, updated);
            incremental = parser.parse(updated, tree);
            fresh = parser.parse(updated);
            assert.equal(fresh.rootNode.hasError, false, updated);
            assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode), updated);
          } finally {
            release(tree, incremental, fresh);
          }
        }
      }
    } finally {
      release(parser);
    }
  });

  test("recognizes table headers once while preserving row fields and ordinary records", () => {
    const parser = createParser();
    try {
      for (const suffix of ["", " ! note", " $ note", " // note", "\uFEFF", " ï»¿"]) {
        const tree = parser.parse(
          `+PROG SOFIMSHA\nNODE NO X Y Z${suffix}\n1 2 3 4\n2 3 4 5\nEND\n`,
        );
        try {
          assert.equal(tree.rootNode.hasError, false, suffix);
          const command = tree.rootNode.descendantsOfType("command")[0];
          assert.deepEqual(
            command.childrenForFieldName("record").map((node) => node.type),
            ["table_definition", "table_row", "table_row"],
            suffix,
          );
          assert.deepEqual(texts(tree, "item_name"), ["NO", "X", "Y", "Z"], suffix);
        } finally {
          release(tree);
        }
      }
      const table = "+PROG SOFIMSHA\nNODE NO X Y Z\n1 2 3 4\nEND\n";
      for (const changed of [
        table.replace("NO X", "NO 1 X"),
        table.replace("X Y", "X unknown Y"),
        table.replace("X Y", "X $(A) Y"),
        table.replace("X Y", "X #A Y"),
      ]) {
        for (const [before, after] of [
          [table, changed],
          [changed, table],
        ]) {
          const tree = parser.parse(before);
          let incremental, fresh;
          try {
            editTree(tree, before, after);
            incremental = parser.parse(after, tree);
            fresh = parser.parse(after);
            assert.equal(fresh.rootNode.hasError, false, after);
            assert.deepEqual(snapshot(incremental.rootNode), snapshot(fresh.rootNode), after);
          } finally {
            release(tree, incremental, fresh);
          }
        }
      }
    } finally {
      release(parser);
    }
  });

  const shapes = {
    program: ["", ""],
    "module tail": ["END\n", ""],
    LOOP: ["LOOP #I 10\n", "ENDLOOP\n"],
    IF: ["IF #I\n", "ENDIF\n"],
    ELSEIF: ["IF #I\nHEAD first\nELSEIF 1\n", "ENDIF\n"],
    ELSE: ["IF #I\nHEAD first\nELSE\n", "ENDIF\n"],
    PICT: ["<PICT>\n", "</PICT>\n"],
    table: ["NODE NO X Y Z\n", ""],
    "implicit records": ["NODE 1 X 0 Y 0 Z 0\n", ""],
  };
  for (const [shape, [opening, closing]] of Object.entries(shapes)) {
    test(`reuses ${shape} rows when editing its last record`, (t) => {
      const parser = createParser();
      const count = 4096;
      const table = shape === "table";
      const implicit = shape === "implicit records";
      const rows = Array.from({ length: count }, (_, index) =>
        table || implicit ? `${index + 1} ${index} 0 0` : `NODE ${index + 1} X ${index} Y 0 Z 0`,
      );
      const before = `+PROG SOFIMSHA\n${opening}${rows.join("\n")}\n${closing}END\n`;
      const start =
        table || implicit ? before.lastIndexOf(" 0 0") + 1 : before.lastIndexOf("Y 0") + 2;
      const after = `${before.slice(0, start)}1${before.slice(start + 1)}`;
      let tree, incremental, fresh;
      try {
        tree = parser.parse(before);
        assert.equal(tree.rootNode.hasError, false);
        editTree(tree, before, after);
        let steps = 0;
        parser.setLogger((message) => {
          if (isLog(message, "process")) steps++;
        });
        incremental = parser.parse(after, tree);
        parser.setLogger(null);
        assert.equal(incremental.rootNode.hasError, false);
        fresh = parser.parse(after);
        assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
        assert.equal(incremental.rootNode.namedChildren.length, 1);
        if (shape === "module tail") {
          assert.equal(
            incremental.rootNode.namedChildren[0].childrenForFieldName("tail").length,
            count + 1,
          );
        }
        if (table || implicit) {
          assert.equal(
            incremental.rootNode.descendantsOfType("command")[0].childrenForFieldName("record")
              .length,
            count + 1,
          );
        }
        assert.equal(
          texts(incremental, table ? "table_row" : implicit ? "implicit_record" : "command_name")
            .length,
          implicit
            ? count
            : table
              ? count
              : shape === "ELSEIF" || shape === "ELSE"
                ? count + 1
                : count,
        );
        assert.ok(steps < count / 8, `${shape}: ${steps} parser steps for ${count} rows`);
        t.diagnostic(`${shape}: ${steps} parser steps for ${count} rows`);
      } finally {
        parser.setLogger(null);
        release(tree, incremental, fresh, parser);
      }
    });
  }
}

module.exports = { registerParserRegressions };
