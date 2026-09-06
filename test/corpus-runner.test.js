const assert = require("node:assert");
const path = require("node:path");
const { test } = require("node:test");
const {
  TRACKED_NODE_TYPES,
  collectFailures,
  collectStructure,
  decode,
  fingerprintFailure,
  hasCorpusFailures,
  hasProgramHeader,
  parseArguments,
} = require("../scripts/test-corpus");
const provenance = require("../schema/provenance.json");
const officialCorpusSummary = require("./official-corpus-summary.json");

test("corpus decoder rejects NUL and invalid UTF-8 input", () => {
  assert.deepStrictEqual(decode(Buffer.from([65, 0, 66])), { skipped: "nul" });
  assert.deepStrictEqual(decode(Buffer.from([0xc3, 0x28])), { skipped: "invalidUtf8" });
  assert.deepStrictEqual(decode(Buffer.from("PROG AQUA\nEND")), {
    source: "PROG AQUA\nEND",
  });
});

test("corpus decoder tries UTF-8 before repeatable fallback encodings", () => {
  assert.deepStrictEqual(decode(Buffer.from("zażółć"), ["windows-1250"]), {
    source: "zażółć",
  });
  assert.deepStrictEqual(decode(Buffer.from([0x50, 0xa3]), ["windows-1250"]), {
    source: "PŁ",
    encoding: "windows-1250",
  });
});

test("treats undecodable text as a corpus failure", () => {
  assert.strictEqual(hasCorpusFailures({ badFiles: 0, skipped: { invalidUtf8: 1 } }), true);
  assert.strictEqual(hasCorpusFailures({ badFiles: 1, skipped: { invalidUtf8: 0 } }), true);
  assert.strictEqual(hasCorpusFailures({ badFiles: 0, skipped: { invalidUtf8: 0 } }), false);
});

test("parses corpus arguments and validates options", () => {
  assert.deepStrictEqual(
    parseArguments(
      [
        "--fallback-encoding",
        "windows-1252",
        "--fallback-encoding=windows-1250",
        "--structure",
        "examples",
      ],
      {},
    ),
    {
      root: "examples",
      fallbackEncodings: ["windows-1252", "windows-1250"],
      help: false,
      structure: true,
    },
  );
  assert.deepStrictEqual(parseArguments([], { SOFISTIK_CORPUS: "installed" }), {
    root: "installed",
    fallbackEncodings: [],
    help: false,
    structure: false,
  });
  assert.deepStrictEqual(parseArguments(["--", "-examples"], {}), {
    root: "-examples",
    fallbackEncodings: [],
    help: false,
    structure: false,
  });
  assert.throws(() => parseArguments(["--unknown"], {}), /Unknown option/);
  assert.throws(() => parseArguments(["one", "two"], {}), /single corpus directory/);
  assert.throws(
    () => parseArguments(["--fallback-encoding", "not-an-encoding"], {}),
    /Unsupported fallback encoding/,
  );
});

test("collects and fingerprints only topmost recovery locations", () => {
  const missing = node(";", { missing: true, row: 2, column: 4 });
  const nestedError = node("ERROR", { row: 3, column: 1 });
  const topmostError = node("ERROR", {
    row: 1,
    column: 2,
    endRow: 3,
    endColumn: 6,
    children: [nestedError],
  });
  const root = node("source_file", { children: [topmostError, missing] });

  const failures = collectFailures(root);
  assert.deepStrictEqual(
    failures.map(({ type }) => type),
    ["ERROR", "MISSING:;"],
  );
  assert.deepStrictEqual(fingerprintFailure(path.join("sub", "example.dat"), failures[0]), {
    file: "sub/example.dat",
    row: 2,
    column: 3,
    endRow: 4,
    endColumn: 7,
    type: "ERROR",
  });
});

test("collects structural coverage and resolver regressions", () => {
  const summary = {
    nodeCounts: { number: 0, hash_variable: 0 },
    dynamicControlCommands: {},
    invalidCommands: {},
    invalidCommandFingerprints: [],
    invalidKopf: 0,
  };
  collectStructure(
    node("source_file", {
      children: [
        node("number", { text: "1" }),
        node("hash_variable", { text: "#A" }),
        node("dynamic_command_name", { text: "IF" }),
        node("invalid_command", { text: "KOPF" }),
      ],
    }),
    summary,
    "example.dat",
  );
  assert.deepStrictEqual(summary.nodeCounts, { number: 1, hash_variable: 1 });
  assert.deepStrictEqual(summary.dynamicControlCommands, { IF: 1 });
  assert.deepStrictEqual(summary.invalidCommands, { KOPF: 1 });
  assert.deepStrictEqual(summary.invalidCommandFingerprints, [
    { file: "example.dat", row: 1, column: 1, text: "KOPF" },
  ]);
  assert.strictEqual(summary.invalidKopf, 1);
});

function node(
  type,
  {
    missing = false,
    row = 0,
    column = 0,
    endRow = row,
    endColumn = column,
    text = "",
    children = [],
  } = {},
) {
  return {
    type,
    isMissing: missing,
    startPosition: { row, column },
    endPosition: { row: endRow, column: endColumn },
    text,
    children,
  };
}

test("distinguishes complete documents from include fragments", () => {
  assert.strictEqual(hasProgramHeader("+PROG AQUA\nEND"), true);
  assert.strictEqual(hasProgramHeader("NODE 1 X 0\nNODE 2 X 1"), false);
});

test("ties the recorded official corpus result to the generated data provenance", () => {
  assert.strictEqual(officialCorpusSummary.formatVersion, 3);
  assert.deepStrictEqual(officialCorpusSummary.data, provenance.source);
  assert.strictEqual(officialCorpusSummary.schemaDigest, provenance.schemaDigest);
  assert.strictEqual(
    officialCorpusSummary.grammarVocabularyDigest,
    provenance.grammarVocabularyDigest,
  );
  assert.deepStrictEqual(Object.keys(officialCorpusSummary.releases), [
    "2018",
    "2020",
    "2022",
    "2023",
    "2024",
    "2025",
    "2026",
  ]);
  for (const [release, summary] of Object.entries(officialCorpusSummary.releases)) {
    assert.strictEqual(
      summary.discovered,
      summary.parsed + summary.skipped.nul + summary.skipped.invalidUtf8,
      `${release} accounting`,
    );
    assert.strictEqual(summary.skipped.invalidUtf8, 0, `${release} undecodable files`);
    assert.strictEqual(
      summary.skippedFiles.length,
      summary.skipped.nul + summary.skipped.invalidUtf8,
      `${release} skipped paths`,
    );
    assert.deepStrictEqual(
      summary.skippedFiles.map(({ file }) => file),
      summary.skippedFiles.map(({ file }) => file).sort(),
      `${release} skipped path order`,
    );
    assert.strictEqual(
      new Set(summary.skippedFiles.map(({ file }) => file)).size,
      summary.skippedFiles.length,
      `${release} unique skipped paths`,
    );
    assert.strictEqual(
      summary.skippedFiles.filter(({ reason }) => reason === "nul").length,
      summary.skipped.nul,
      `${release} NUL paths`,
    );
    assert.strictEqual(
      summary.skippedFiles.filter(({ reason }) => reason === "invalidUtf8").length,
      summary.skipped.invalidUtf8,
      `${release} invalid UTF-8 paths`,
    );
    assert.deepStrictEqual(
      summary.fallbackFiles.map(({ file }) => file),
      summary.fallbackFiles.map(({ file }) => file).sort(),
      `${release} fallback path order`,
    );
    assert.strictEqual(
      new Set(summary.fallbackFiles.map(({ file }) => file)).size,
      summary.fallbackFiles.length,
      `${release} unique fallback paths`,
    );
    for (const { encoding } of summary.fallbackFiles) {
      assert.ok(summary.fallbackEncodings.includes(encoding), `${release} fallback ${encoding}`);
    }
    assert.strictEqual(summary.badFiles, 0, `${release} bad files`);
    assert.strictEqual(summary.errorNodes, 0, `${release} recovery nodes`);
    assert.deepStrictEqual(summary.classifications, {}, `${release} recovery classifications`);
    assert.deepStrictEqual(summary.failureFingerprints, [], `${release} recovery fingerprints`);
    assert.deepStrictEqual(
      summary.fileClassifications,
      {
        fragmentWithoutProgram: { files: 0, errorNodes: 0 },
        documentWithUnsupportedSyntax: { files: 0, errorNodes: 0 },
      },
      `${release} file classifications`,
    );
    assert.deepStrictEqual(
      Object.keys(summary.nodeCounts),
      [...TRACKED_NODE_TYPES],
      `${release} structural keys`,
    );
    assert.deepStrictEqual(summary.dynamicControlCommands, {}, `${release} dynamic controls`);
    assert.deepStrictEqual(summary.invalidCommands, {}, `${release} invalid commands`);
    assert.deepStrictEqual(
      summary.invalidCommandFingerprints,
      [],
      `${release} invalid command fingerprints`,
    );
    assert.strictEqual(summary.invalidKopf, 0, `${release} invalid KOPF`);
    assert.strictEqual(summary.nodeCounts.invalid_command, 0, `${release} invalid command nodes`);
    assert.ok(summary.nodeCounts.number > 1_000_000, `${release} numeric coverage`);
    assert.ok(summary.nodeCounts.hash_variable > 100_000, `${release} variable coverage`);
    assert.ok(summary.nodeCounts.picture_block > 0, `${release} picture coverage`);
    assert.ok(summary.nodeCounts.invalid_at_reference > 0, `${release} invalid @ coverage`);
    assert.ok(summary.nodeCounts.orphan_endloop_record > 0, `${release} orphan ENDLOOP coverage`);
    assert.ok(summary.nodeCounts.orphan_endif_record > 0, `${release} orphan ENDIF coverage`);
    assert.ok(summary.nodeCounts.orphan_text_end > 0, `${release} orphan TEXT coverage`);
    assert.ok(
      summary.nodeCounts.unterminated_double_quoted_string > 0,
      `${release} unterminated string coverage`,
    );
    assert.ok(summary.nodeCounts.unterminated_input_block > 0, `${release} missing END coverage`);
  }
});
