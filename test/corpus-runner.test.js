const assert = require("node:assert");
const { test } = require("node:test");
const { decode } = require("../scripts/test-corpus");

test("corpus decoder rejects NUL and invalid UTF-8 input", () => {
  assert.deepStrictEqual(decode(Buffer.from([65, 0, 66])), { skipped: "nul" });
  assert.deepStrictEqual(decode(Buffer.from([0xc3, 0x28])), { skipped: "invalidUtf8" });
  assert.deepStrictEqual(decode(Buffer.from("PROG AQUA\nEND")), {
    source: "PROG AQUA\nEND",
  });
});
