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

test("keeps Wasm record and parenthesis scaling linear", { timeout: 30000 }, () => {
  const parser = new TreeSitter.Parser();
  parser.setLanguage(language);
  const makeRecords = (count) =>
    `+PROG TEMPLATE\n${Array.from(
      { length: count },
      (_, index) => `CMD${index} #VALUE${index} "quoted value"`,
    ).join(" ; ")}\nEND`;
  const makeNested = (depth) =>
    `+PROG AQUA\nHEAD ${"(".repeat(depth)}#VALUE${")".repeat(depth)}\nEND`;

  const measureBatch = (source, repetitions, rounds = 5) => {
    const durations = [];
    for (let round = 0; round < rounds; round++) {
      const started = performance.now();
      for (let iteration = 0; iteration < repetitions; iteration++) {
        const tree = assertHealthyTree(parser.parse(source), `scaling parse ${round}:${iteration}`);
        tree.delete();
      }
      durations.push(performance.now() - started);
    }
    return median(durations);
  };

  try {
    const smallRecords = makeRecords(128);
    const largeRecords = makeRecords(2048);
    measureBatch(smallRecords, 1, 2);
    measureBatch(largeRecords, 1, 2);
    const smallBatch = measureBatch(smallRecords, 16);
    const largeParse = measureBatch(largeRecords, 1);
    assert.ok(
      largeParse < smallBatch * 6,
      `Wasm record parse scaled superlinearly: ${smallBatch.toFixed(2)}ms vs ${largeParse.toFixed(2)}ms`,
    );

    const nested800 = measureBatch(makeNested(800), 1, 7);
    const nested1600 = measureBatch(makeNested(1600), 1, 7);
    assert.ok(
      nested1600 < nested800 * 3,
      `Wasm parenthesis parse scaled superlinearly: ${nested800.toFixed(2)}ms vs ${nested1600.toFixed(2)}ms`,
    );
  } finally {
    parser.delete();
  }
});
