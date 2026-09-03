const assert = require("node:assert");
const { test } = require("node:test");
const { decode, hasProgramHeader } = require("../scripts/test-corpus");
const provenance = require("../schema/provenance.json");
const officialCorpusSummary = require("./official-corpus-summary.json");

test("corpus decoder rejects NUL and invalid UTF-8 input", () => {
  assert.deepStrictEqual(decode(Buffer.from([65, 0, 66])), { skipped: "nul" });
  assert.deepStrictEqual(decode(Buffer.from([0xc3, 0x28])), { skipped: "invalidUtf8" });
  assert.deepStrictEqual(decode(Buffer.from("PROG AQUA\nEND")), {
    source: "PROG AQUA\nEND",
  });
});

test("distinguishes complete documents from include fragments", () => {
  assert.strictEqual(hasProgramHeader("+PROG AQUA\nEND"), true);
  assert.strictEqual(hasProgramHeader("NODE 1 X 0\nNODE 2 X 1"), false);
});

test("ties the recorded official corpus result to the generated data provenance", () => {
  assert.deepStrictEqual(officialCorpusSummary.data, provenance.source);
  assert.strictEqual(officialCorpusSummary.schemaDigest, provenance.schemaDigest);
  assert.strictEqual(
    officialCorpusSummary.grammarVocabularyDigest,
    provenance.grammarVocabularyDigest,
  );
});
