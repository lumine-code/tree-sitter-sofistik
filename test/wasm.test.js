const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { before, test } = require("node:test");
const TreeSitter = require("web-tree-sitter");

const wasmPath = path.join(__dirname, "..", "tree-sitter-sofistik.wasm");
const runtimePackagePath = path.join(
  path.dirname(require.resolve("web-tree-sitter")),
  "package.json",
);
const source = ["+PROG SOFIMSHA", "HEAD Web Tree Sitter", "NODE 1 X 0 Y 0 Z 0", "END", ""].join(
  "\n",
);

let language;

function assertHealthyTree(tree, context) {
  assert.ok(tree, `${context} returned null`);
  if (tree.rootNode.hasError) {
    assert.fail(`${context} produced a recovery node: ${tree.rootNode.toString().slice(0, 1000)}`);
  }
  return tree;
}

function pointAt(text, index) {
  const prefix = text.slice(0, index);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return {
    row: prefix.split("\n").length - 1,
    column: Buffer.byteLength(prefix.slice(lineStart)),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

before(async () => {
  await TreeSitter.Parser.init();
  language = await TreeSitter.Language.load(wasmPath);
});

test("keeps control words inside command prose as bare values", () => {
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  try {
    for (const command of ["HEAD", "TXB"]) {
      for (const word of ["ELSE", "ELSEIF", "ENDIF", "ENDLOOP", "EXIT_ITERATION", "IF", "LOOP"]) {
        const source = `+PROG TEMPLATE\n${command} example ${word.toLowerCase()} prose\nEND\n`;
        const context = `${command} ${word}`;
        const tree = assertHealthyTree(parser.parse(source), context);
        try {
          assert.deepStrictEqual(
            tree.rootNode.descendantsOfType("command_name").map((node) => node.text),
            [command],
            context,
          );
          assert.deepStrictEqual(
            tree.rootNode.descendantsOfType("bare_value").map((node) => node.text),
            ["example", word.toLowerCase(), "prose"],
            context,
          );
          assert.deepStrictEqual(
            tree.rootNode.descendantsOfType("control_keyword").map((node) => node.text),
            ["END"],
            context,
          );
        } finally {
          tree.delete();
        }
      }
    }
  } finally {
    parser.delete();
  }
});

test("preserves heading prose and module rows across record boundaries", () => {
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  try {
    const tree = assertHealthyTree(
      parser.parse(
        "+PROG TEMPLATE\nHEAD @NAME ; selector KWL not necessary\n" +
          "UNKNOWN new line\nKOPF text ; NODE 1\nEND\n" +
          "+PROG SIR\nEND\nSECT NO XS XM\n2 0.0 -1.5\n\n3 1.0 -2.5\nEND\n",
      ),
      "heading and blank-line records",
    );
    try {
      assert.deepStrictEqual(
        tree.rootNode.descendantsOfType("invalid_command").map((node) => node.text),
        ["UNKNOWN", "NODE"],
      );
      assert.strictEqual(tree.rootNode.descendantsOfType("cdb_statement").length, 0);
      assert.strictEqual(tree.rootNode.descendantsOfType("table_row").length, 2);
      assert.strictEqual(tree.rootNode.descendantsOfType("program").length, 2);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
});

test("scopes deferred TEMPLATE DEFINE validation across bodies and scalar definitions", () => {
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  const cases = [
    [
      "+PROG TEMPLATE\nDSLC 1\n#define outer-block $ deferred\nHEAD macro\nDSLC 2\n" +
        "#define inner\nDSLC 3\n#enddef\nDSLN 4\n#enddef\nDSLC 5\n" +
        "#define repeated\nDSLC 6\nTXB description\n#enddef\nDSLC 7\nEND\n",
      3,
      ["HEAD", "TXB"],
    ],
    ["+PROG TEMPLATE\n#define scalar=1\nDSLC 1\nEND\n", 1, []],
    ["+PROG TEMPLATE\n#define scalar value\nDSLC 1\nEND\n", 1, []],
    ["+PROG TEMPLATE\n#define open\nDSLC 1\nEND\n+PROG TEMPLATE\nDSLC 2\nEND\n", 1, []],
  ];
  try {
    for (const [source, invalidCount, commands] of cases) {
      const tree = assertHealthyTree(parser.parse(source), source);
      try {
        assert.strictEqual(tree.rootNode.descendantsOfType("invalid_command").length, invalidCount);
        assert.deepStrictEqual(
          tree.rootNode.descendantsOfType("command_name").map((node) => node.text),
          commands,
        );
      } finally {
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test("restores Wasm TEMPLATE DEFINE depth after incremental body and boundary edits", () => {
  const before = "+PROG TEMPLATE\n#define block\nDSLC 1\n#enddef\nDSLC 2\nEND\n";
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  try {
    for (const [after, invalidCount] of [
      [before.replace("DSLC 1", "DSLN 1"), 1],
      [before.replace("#define block", "#define block=1"), 2],
      [before.replace("#enddef\n", ""), 0],
      [before.replace("#define block\n", "#define block\n#define inner\n"), 0],
      [before.replace("#enddef", "+PROG TEMPLATE"), 1],
    ]) {
      let startIndex = 0;
      while (before[startIndex] === after[startIndex] && startIndex < before.length) startIndex++;
      let suffixLength = 0;
      while (
        suffixLength < before.length - startIndex &&
        suffixLength < after.length - startIndex &&
        before[before.length - suffixLength - 1] === after[after.length - suffixLength - 1]
      )
        suffixLength++;
      const oldEndIndex = before.length - suffixLength;
      const newEndIndex = after.length - suffixLength;
      const tree = assertHealthyTree(parser.parse(before), "DEFINE before edit");
      let incremental;
      let fresh;
      try {
        tree.edit({
          startIndex,
          oldEndIndex,
          newEndIndex,
          startPosition: pointAt(before, startIndex),
          oldEndPosition: pointAt(before, oldEndIndex),
          newEndPosition: pointAt(after, newEndIndex),
        });
        incremental = assertHealthyTree(parser.parse(after, tree), after);
        fresh = assertHealthyTree(parser.parse(after), "DEFINE fresh parse");
        assert.strictEqual(incremental.rootNode.toString(), fresh.rootNode.toString());
        assert.strictEqual(
          incremental.rootNode.descendantsOfType("invalid_command").length,
          invalidCount,
        );
      } finally {
        fresh?.delete();
        incremental?.delete();
        tree.delete();
      }
    }
  } finally {
    parser.delete();
  }
});

test("loads the root Wasm grammar with the pinned compatible runtime", () => {
  const runtimePackage = JSON.parse(readFileSync(runtimePackagePath, "utf8"));
  const wasm = readFileSync(wasmPath);

  assert.strictEqual(runtimePackage.version, "0.27.0");
  assert.ok(WebAssembly.validate(wasm));
  assert.strictEqual(language.name, "sofistik");
  assert.strictEqual(language.abiVersion, TreeSitter.LANGUAGE_VERSION);
  assert.ok(language.abiVersion >= TreeSitter.MIN_COMPATIBLE_VERSION);
  assert.ok(language.stateCount > 0);
  assert.ok(language.nodeTypeCount > 0);
});

test("survives 1000 parse and reset cycles", { timeout: 30000 }, () => {
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);

  try {
    for (let iteration = 0; iteration < 1000; iteration++) {
      const tree = assertHealthyTree(parser.parse(source), `parse/reset iteration ${iteration}`);
      tree.delete();
      parser.reset();
    }
  } finally {
    parser.delete();
  }
});

test("survives 100 parser create and delete cycles", { timeout: 30000 }, () => {
  for (let iteration = 0; iteration < 100; iteration++) {
    const parser = new TreeSitter.Parser();
    try {
      parser.setLanguage(language);
      const tree = assertHealthyTree(
        parser.parse(source),
        `parser lifecycle iteration ${iteration}`,
      );
      tree.delete();
    } finally {
      parser.delete();
    }
  }
});

test("500 incremental edits match fresh parses", { timeout: 30000 }, () => {
  const incrementalParser = new TreeSitter.Parser();
  const freshParser = new TreeSitter.Parser();
  incrementalParser.setLanguage(language);
  freshParser.setLanguage(language);

  let currentSource = source;
  let currentTree;
  try {
    currentTree = assertHealthyTree(incrementalParser.parse(currentSource), "initial parse");

    for (let iteration = 0; iteration < 500; iteration++) {
      const oldValue = iteration % 2 === 0 ? "0" : "2.5";
      const newValue = iteration % 2 === 0 ? "2.5" : "0";
      const startIndex = currentSource.indexOf(`Y ${oldValue}`) + 2;
      const oldEndIndex = startIndex + oldValue.length;
      const newEndIndex = startIndex + newValue.length;
      const updatedSource =
        currentSource.slice(0, startIndex) + newValue + currentSource.slice(oldEndIndex);

      currentTree.edit({
        startIndex,
        oldEndIndex,
        newEndIndex,
        startPosition: pointAt(currentSource, startIndex),
        oldEndPosition: pointAt(currentSource, oldEndIndex),
        newEndPosition: pointAt(updatedSource, newEndIndex),
      });

      let incrementalTree;
      let freshTree;
      try {
        incrementalTree = assertHealthyTree(
          incrementalParser.parse(updatedSource, currentTree),
          `incremental parse ${iteration}`,
        );
        freshTree = assertHealthyTree(freshParser.parse(updatedSource), `fresh parse ${iteration}`);
        assert.strictEqual(incrementalTree.rootNode.toString(), freshTree.rootNode.toString());
      } catch (error) {
        incrementalTree?.delete();
        throw error;
      } finally {
        freshTree?.delete();
      }

      currentTree.delete();
      currentTree = incrementalTree;
      currentSource = updatedSource;
    }
  } finally {
    currentTree?.delete();
    freshParser.delete();
    incrementalParser.delete();
  }
});

test("parses callback input in chunks no larger than 4096 bytes", () => {
  const callbackSource = [
    "+PROG SOFIMSHA",
    ...Array.from({ length: 600 }, (_, index) => `NODE ${index + 1} X ${index} Y 0 Z 0`),
    "END",
    "",
  ].join("\n");
  const reads = [];
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);

  try {
    assert.ok(Buffer.byteLength(callbackSource) > 8192);
    const tree = assertHealthyTree(
      parser.parse((index) => {
        if (index >= callbackSource.length) return undefined;
        const chunk = callbackSource.slice(index, index + 4096);
        reads.push({ index, bytes: Buffer.byteLength(chunk) });
        return chunk;
      }),
      "chunked callback parse",
    );

    assert.ok(reads.length > 1);
    assert.ok(reads.some((read) => read.bytes === 4096));
    assert.ok(reads.some((read) => read.index >= 4096));
    assert.ok(reads.every((read) => read.bytes > 0 && read.bytes <= 4096));
    tree.delete();
  } finally {
    parser.delete();
  }
});

test("reuses large program bodies when typing after END", () => {
  const commandCount = 8192;
  const originalSource = [
    "+PROG SOFIMSHA",
    ...Array.from({ length: commandCount }, (_, index) => `NODE ${index + 1} X ${index} Y 0 Z 0`),
    "END",
    "",
  ].join("\n");
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  let tree;

  try {
    tree = assertHealthyTree(parser.parse(originalSource), "large program parse");
    const block = tree.rootNode.namedChildren[0].childForFieldName("body");
    assert.strictEqual(block.namedChildCount, commandCount + 1);
    assert.strictEqual(block.namedChildren[0].type, "command");
    assert.strictEqual(block.namedChildren.at(-1).type, "end_record");

    const position = pointAt(originalSource, originalSource.length);
    tree.edit({
      startIndex: originalSource.length,
      oldEndIndex: originalSource.length,
      newEndIndex: originalSource.length + 1,
      startPosition: position,
      oldEndPosition: position,
      newEndPosition: { row: position.row, column: position.column + 1 },
    });

    let processCount = 0;
    parser.setLogger((message) => {
      if (message.startsWith("process ")) processCount++;
    });
    const updatedSource = `${originalSource}x`;
    const updatedTree = assertHealthyTree(parser.parse(updatedSource, tree), "large program edit");
    parser.setLogger(null);
    tree.delete();
    tree = updatedTree;

    assert.ok(
      processCount < commandCount / 8,
      `An end edit replayed ${processCount} parser steps for ${commandCount} commands`,
    );
    const freshTree = assertHealthyTree(parser.parse(updatedSource), "large program fresh parse");
    try {
      assert.strictEqual(tree.rootNode.toString(), freshTree.rootNode.toString());
    } finally {
      freshTree.delete();
    }
  } finally {
    parser.setLogger(null);
    tree?.delete();
    parser.delete();
  }
});

test("keeps Wasm record and parenthesis scaling linear", { timeout: 30000 }, (t) => {
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  const makeRecords = (count) =>
    `+PROG TEMPLATE\n${Array.from(
      { length: count },
      (_, index) => `KOPF "${index} quoted value"`,
    ).join(" ; ")}\nEND`;
  const makeNested = (depth) =>
    `+PROG AQUA\nHEAD ${"(".repeat(depth)}#VALUE${")".repeat(depth)}\nEND`;

  const measureBatch = (source, repetitions) => {
    const started = performance.now();
    for (let iteration = 0; iteration < repetitions; iteration++) {
      const tree = assertHealthyTree(parser.parse(source), "scaling parse");
      tree.delete();
    }
    return performance.now() - started;
  };
  const measurePair = (small, large, smallRepetitions, largeRepetitions) => {
    // Warm both shapes before calibrating. Separate small/large phases can
    // compare different Wasm tiers or CPU load instead of the input sizes.
    for (let round = 0; round < 3; round++) {
      measureBatch(small, smallRepetitions);
      measureBatch(large, largeRepetitions);
    }
    const smallWarm = measureBatch(small, smallRepetitions);
    const largeWarm = measureBatch(large, largeRepetitions);
    // Scale both workloads together so each sample spans at least roughly
    // 40 ms without changing the ratio of input work or the acceptance bound.
    const multiplier = Math.max(1, Math.ceil(40 / Math.min(smallWarm, largeWarm)));
    const pairs = [];
    for (let round = 0; round < 9; round++) {
      let smallMs, largeMs;
      if (round % 2 === 0) {
        smallMs = measureBatch(small, smallRepetitions * multiplier);
        largeMs = measureBatch(large, largeRepetitions * multiplier);
      } else {
        largeMs = measureBatch(large, largeRepetitions * multiplier);
        smallMs = measureBatch(small, smallRepetitions * multiplier);
      }
      pairs.push({ smallMs, largeMs });
    }
    return {
      ratio: median(pairs.map(({ smallMs, largeMs }) => largeMs / smallMs)),
      smallMs: median(pairs.map(({ smallMs }) => smallMs)),
      largeMs: median(pairs.map(({ largeMs }) => largeMs)),
    };
  };

  try {
    const smallRecords = makeRecords(128);
    const largeRecords = makeRecords(2048);
    const records = measurePair(smallRecords, largeRecords, 16, 1);
    t.diagnostic(`Wasm equal-volume record batches: ${records.ratio.toFixed(2)}x paired median`);
    assert.ok(
      records.ratio < 6,
      `Wasm record parse scaled superlinearly: ${records.smallMs.toFixed(2)}ms vs ${records.largeMs.toFixed(2)}ms (${records.ratio.toFixed(2)}x paired median)`,
    );

    const smallNested = makeNested(800);
    const largeNested = makeNested(1600);
    for (const [nested, depth] of [
      [smallNested, 800],
      [largeNested, 1600],
    ]) {
      const tree = assertHealthyTree(parser.parse(nested), "nested scaling fixture");
      try {
        assert.strictEqual(
          tree.rootNode.descendantsOfType("parenthesized_expression").length,
          depth,
        );
      } finally {
        tree.delete();
      }
    }
    const nested = measurePair(smallNested, largeNested, 32, 32);
    t.diagnostic(`Wasm doubled parenthesis depth: ${nested.ratio.toFixed(2)}x paired median`);
    assert.ok(
      nested.ratio < 3,
      `Wasm parenthesis parse scaled superlinearly: ${nested.smallMs.toFixed(2)}ms vs ${nested.largeMs.toFixed(2)}ms (${nested.ratio.toFixed(2)}x paired median)`,
    );
  } finally {
    parser.delete();
  }
});
