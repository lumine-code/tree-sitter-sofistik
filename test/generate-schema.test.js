const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { buildTables, generateSchema } = require("../scripts/generate-schema");

const fixture = {
  digest: "fixture-digest",
  modules: {
    BASIC: {
      commands: {
        HEAD: { items: [], signatures: [] },
      },
    },
    AQUA: {
      commands: {
        CONC: {
          items: ["NO", "TYPE"],
          signatures: [
            {
              slots: [
                { name: "NO", enumValues: [] },
                { name: "TYPE", enumValues: ["C", "LC"] },
              ],
            },
          ],
        },
      },
    },
  },
};

test("builds module-local scanner ranges with BASIC commands", () => {
  const tables = buildTables(fixture);
  assert.deepStrictEqual(tables.modules, [{ name: "AQUA", commandStart: 0, commandCount: 2 }]);
  assert.deepStrictEqual(
    tables.commands.map((command) => command.name),
    ["CONC", "HEAD"],
  );
  assert.deepStrictEqual(tables.enums, ["C", "LC"]);
  assert.deepStrictEqual(tables.globalCommands, ["CONC", "HEAD"]);
});

test("writes a deterministic C header", (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-sofistik-"));
  const source = path.join(temporaryDirectory, "snapshot.json");
  const output = path.join(temporaryDirectory, "schema.h");
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  fs.writeFileSync(source, JSON.stringify(fixture));

  generateSchema(source, output);
  const first = fs.readFileSync(output, "utf8");
  generateSchema(source, output);
  const second = fs.readFileSync(output, "utf8");

  assert.strictEqual(first, second);
  assert.match(first, /SOFISTIK_SCHEMA_DIGEST "fixture-digest"/);
  assert.match(first, /\{"AQUA", 0, 2\}/);
});
