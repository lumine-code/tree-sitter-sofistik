const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { buildTables, generateSchema } = require("../scripts/generate-schema");
const snapshot = require("../schema/snapshot.json");

function commandsInRange(tables, start, count) {
  return new Map(
    tables.commands
      .slice(start, start + count)
      .map((command) => [
        command.name,
        tables.items.slice(command.itemStart, command.itemStart + command.itemCount),
      ]),
  );
}

const fixture = {
  digest: "fixture-digest",
  modules: {
    BASIC: {
      commands: {
        HEAD: { items: ["TITL"], signatures: [] },
        PAGE: { items: ["UNII"], signatures: [] },
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
        HEAD: { items: ["LOCAL"], signatures: [] },
      },
    },
    ASE: { commands: {} },
  },
};

test("builds module-local scanner ranges with BASIC commands", () => {
  const tables = buildTables(fixture);
  assert.strictEqual(tables.basicCommandStart, 0);
  assert.strictEqual(tables.basicCommandCount, 2);
  assert.deepStrictEqual(tables.modules, [
    { name: "AQUA", commandStart: 2, commandCount: 2 },
    { name: "ASE", commandStart: 4, commandCount: 0 },
  ]);
  assert.deepStrictEqual(
    tables.commands.map((command) => command.name),
    ["HEAD", "PAGE", "CONC", "HEAD"],
  );
  assert.deepStrictEqual(tables.items, ["TITL", "UNII", "NO", "TYPE", "LOCAL"]);
  assert.deepStrictEqual(tables.globalCommands, ["CONC", "HEAD", "PAGE"]);
  assert.strictEqual("enums" in tables, false);
  assert.strictEqual("globalItems" in tables, false);
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
  assert.match(first, /\{"AQUA", 2, 2\}/);
  assert.match(first, /SOFISTIK_BASIC_COMMAND_START 0u/);
  assert.match(first, /SOFISTIK_BASIC_COMMAND_COUNT 2u/);
  assert.match(first, /static const char \*const SOFISTIK_ITEMS\[\]/);
  assert.match(first, / {2}"TITL",\n {2}"UNII",\n {2}"NO",\n {2}"TYPE",\n {2}"LOCAL",/);
  assert.doesNotMatch(first, /SofistikItemSchema/);
  assert.doesNotMatch(first, /SOFISTIK_ENUM/);
  assert.doesNotMatch(first, /SOFISTIK_GLOBAL_ITEM/);
});

test("deduplicated BASIC ranges preserve every module vocabulary", () => {
  const tables = buildTables(snapshot);
  const basic = commandsInRange(tables, tables.basicCommandStart, tables.basicCommandCount);

  for (const module of tables.modules) {
    const local = commandsInRange(tables, module.commandStart, module.commandCount);
    const expectedCommands = {
      ...snapshot.modules.BASIC.commands,
      ...snapshot.modules[module.name].commands,
    };
    delete expectedCommands.END;
    delete expectedCommands.ENDE;

    assert.deepStrictEqual(
      [...new Set([...basic.keys(), ...local.keys()])].sort(),
      Object.keys(expectedCommands).sort(),
      `${module.name} command names`,
    );
    for (const [commandName, command] of Object.entries(expectedCommands)) {
      assert.deepStrictEqual(
        local.get(commandName) || basic.get(commandName),
        command.items,
        `${module.name}/${commandName} items`,
      );
    }
  }
});
