const assert = require("node:assert");
const { test } = require("node:test");
const SOFiSTiK = require(".");

test("loads the grammar through the Node-API binding", () => {
  assert.strictEqual(SOFiSTiK.name, "sofistik");
  assert.ok(SOFiSTiK.language);
  assert.ok(Array.isArray(SOFiSTiK.nodeTypeInfo));
});
