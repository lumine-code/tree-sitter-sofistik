const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
const { Parser, Language } = require("web-tree-sitter");

const fixtures = {
  aqua: { source: "CONC NO 1 TYPE C30", command: "CONC", items: ["NO", "TYPE"] },
  sofimshc: { source: "SPTP X 1 Y 0 Z 0", command: "SPTP", items: ["X", "Y", "Z"] },
  sofiload: { source: "LC NO 1 TYPE NONE", command: "LC", items: ["NO", "TYPE"] },
  decreator: { source: "DSID NO 1", command: "DSID", items: ["NO"] },
  tendon: { source: "AXES NRH 1 S 0", command: "AXES", items: ["NRH", "S"] },
};
const languages = new Map();
let baseLanguage;

before(async () => {
  await Parser.init();
  baseLanguage = await Language.load(path.join(__dirname, "..", "tree-sitter-sofistik.wasm"));
  for (const module of Object.keys(fixtures)) {
    languages.set(
      module,
      await Language.load(path.join(__dirname, "..", "include", module, `sofistik-${module}.wasm`)),
    );
  }
});

function texts(tree, type) {
  return tree.rootNode.descendantsOfType(type).map((node) => node.text);
}

function healthyParse(parser, source, oldTree) {
  const tree = parser.parse(source, oldTree);
  assert.ok(tree);
  assert.equal(tree.rootNode.hasError, false, tree.rootNode.toString());
  return tree;
}

function withParser(language, run) {
  const parser = new Parser();
  parser.setLanguage(language);
  try {
    return run(parser);
  } finally {
    parser.delete();
  }
}

function positionAt(source, index) {
  const prefix = source.slice(0, index);
  return { row: prefix.split("\n").length - 1, column: index - prefix.lastIndexOf("\n") - 1 };
}

function replaceTreeSource(tree, before, after) {
  let startIndex = 0;
  while (startIndex < before.length && before[startIndex] === after[startIndex]) startIndex++;
  let suffixLength = 0;
  while (
    suffixLength < before.length - startIndex &&
    suffixLength < after.length - startIndex &&
    before[before.length - suffixLength - 1] === after[after.length - suffixLength - 1]
  ) {
    suffixLength++;
  }
  const oldEndIndex = before.length - suffixLength;
  const newEndIndex = after.length - suffixLength;
  tree.edit({
    startIndex,
    oldEndIndex,
    newEndIndex,
    startPosition: positionAt(before, startIndex),
    oldEndPosition: positionAt(before, oldEndIndex),
    newEndPosition: positionAt(after, newEndIndex),
  });
}

test("SOFILOAD include ends tables before variable setup without losing its module", () => {
  withParser(languages.get("sofiload"), (parser) => {
    const source =
      "ACT TYPE PART SUP\nlp_u q_1 cond\nsto#D_f 0.21\nLet #B_1 -1.175\nACT TYPE PART SUP\nlp_x q_1 unsi\nLC 1\nEND\n";
    const tree = healthyParse(parser, source);
    try {
      assert.deepEqual(texts(tree, "module_name"), []);
      assert.deepEqual(texts(tree, "command_name"), ["ACT", "ACT", "LC"]);
      assert.deepEqual(texts(tree, "variable_keyword"), ["sto", "Let"]);
      assert.equal(texts(tree, "table_row").length, 2);
      assert.equal(texts(tree, "table_definition").length, 2);
      for (const variable of tree.rootNode.descendantsOfType("variable_statement")) {
        assert.equal(variable.parent.type, "source_file");
      }
    } finally {
      tree.delete();
    }
  });
});

for (const [module, fixture] of Object.entries(fixtures)) {
  test(`${module} include starts with module commands and items at real source positions`, () => {
    withParser(languages.get(module), (parser) => {
      const tree = healthyParse(parser, `${fixture.source}\nEND\n${fixture.source}\nEND\n`);
      try {
        assert.deepEqual(texts(tree, "command_name"), [fixture.command, fixture.command]);
        assert.deepEqual(texts(tree, "item_name"), [...fixture.items, ...fixture.items]);
        assert.deepEqual(texts(tree, "module_name"), []);
        assert.deepEqual(texts(tree, "control_keyword"), ["END", "END"]);
        const firstCommand = tree.rootNode.descendantsOfType("command_name")[0];
        assert.equal(firstCommand.startIndex, 0);
        assert.deepEqual(firstCommand.startPosition, { row: 0, column: 0 });
      } finally {
        tree.delete();
      }
    });
  });

  test(`${module} include accepts only commands belonging to the initial module`, () => {
    const other = fixtures[module === "aqua" ? "sofimshc" : "aqua"];
    withParser(languages.get(module), (parser) => {
      const tree = healthyParse(parser, `${other.source}\nEND\n`);
      try {
        assert.deepEqual(texts(tree, "command_name"), []);
        assert.deepEqual(texts(tree, "item_name"), []);
      } finally {
        tree.delete();
      }
    });
  });

  test(`${module} include permits explicit program and commented module overrides`, () => {
    const otherModule = module === "aqua" ? "sofimshc" : "aqua";
    const other = fixtures[otherModule];
    withParser(languages.get(module), (parser) => {
      for (const sigil of ["+PROG", "$PROG"]) {
        const source =
          `${fixture.source}\nEND\n${sigil} ${otherModule.toUpperCase()}\n` +
          `${other.source}\nEND\n${fixture.source}\nEND\n`;
        const tree = healthyParse(parser, source);
        try {
          assert.deepEqual(texts(tree, "command_name"), [fixture.command, other.command]);
          assert.deepEqual(texts(tree, "module_name"), [otherModule.toUpperCase()]);
        } finally {
          tree.delete();
        }
      }
    });
  });

  test(`${module} include clears context at root directives and restores it on parser reset`, () => {
    withParser(languages.get(module), (parser) => {
      for (const directive of ["SYS echo context", "APPLY other.dat", "+PROG UNKNOWN\nEND"]) {
        const tree = healthyParse(
          parser,
          `${fixture.source}\nEND\n${directive}\n${fixture.source}\n`,
        );
        try {
          assert.deepEqual(texts(tree, "command_name"), [fixture.command]);
        } finally {
          tree.delete();
        }
        parser.reset();
        const restored = healthyParse(parser, `${fixture.source}\n`);
        try {
          assert.deepEqual(texts(restored, "command_name"), [fixture.command]);
          assert.deepEqual(texts(restored, "item_name"), fixture.items);
        } finally {
          restored.delete();
        }
      }
    });
  });

  test(`${module} include incremental edits and context changes match fresh parses`, () => {
    withParser(languages.get(module), (parser) => {
      let source = `${fixture.source}\nEND\n${fixture.source}\nEND\n`;
      let tree = healthyParse(parser, source);
      try {
        for (const nextSource of [
          source.replace("1", "15"),
          `+PROG TEMPLATE\n${source}`,
          source,
          `$PROG ${module.toUpperCase()}\n${source}`,
          source.replace(fixture.command, fixture.command.toLowerCase()),
          "",
          source,
        ]) {
          replaceTreeSource(tree, source, nextSource);
          const incremental = healthyParse(parser, nextSource, tree);
          const fresh = healthyParse(parser, nextSource);
          try {
            assert.equal(incremental.rootNode.toString(), fresh.rootNode.toString());
            assert.deepEqual(texts(incremental, "command_name"), texts(fresh, "command_name"));
            assert.deepEqual(texts(incremental, "item_name"), texts(fresh, "item_name"));
          } finally {
            fresh.delete();
          }
          tree.delete();
          tree = incremental;
          source = nextSource;
        }
      } finally {
        tree.delete();
      }
    });
  });
}

test("the base CADINP parser retains an unknown initial module", () => {
  withParser(baseLanguage, (parser) => {
    const tree = healthyParse(parser, `${fixtures.aqua.source}\nEND\n`);
    try {
      assert.deepEqual(texts(tree, "command_name"), []);
      assert.deepEqual(texts(tree, "item_name"), []);
    } finally {
      tree.delete();
    }
  });
});
