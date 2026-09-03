const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const snapshotPath = path.join(root, "schema", "snapshot.json");
const outputPath = path.join(root, "src", "schema.h");
const RESERVED_COMMANDS = new Set(["END", "ENDE"]);
// The .err headers expose internal component names, while CADINP uses the
// executable names shown in program headers and example files.
const MODULE_ALIASES = Object.freeze({
  DBMERG: "DBME",
  STAR2: "STAR",
  TUNARS: "TUNA",
});
const UNIVERSAL_COMMANDS = Object.freeze({
  HEAD: { items: [] },
});

function cString(value) {
  return JSON.stringify(value);
}

function buildTables(snapshot) {
  const basic = { ...UNIVERSAL_COMMANDS, ...snapshot.modules.BASIC?.commands };
  const moduleNames = Object.keys(snapshot.modules)
    .filter((name) => name !== "BASIC")
    .sort();
  const modules = [];
  const commands = [];
  const items = [];
  const globalCommands = new Set();

  function appendCommands(commandMap) {
    const names = Object.keys(commandMap)
      .filter((name) => !RESERVED_COMMANDS.has(name))
      .sort();

    for (const commandName of names) {
      const command = commandMap[commandName];
      const itemStart = items.length;
      globalCommands.add(commandName);

      items.push(...command.items);
      commands.push({
        name: commandName,
        itemStart,
        itemCount: items.length - itemStart,
      });
    }
  }

  const basicCommandStart = commands.length;
  appendCommands(basic);
  const basicCommandCount = commands.length - basicCommandStart;

  for (const moduleName of moduleNames) {
    const commandStart = commands.length;
    appendCommands(snapshot.modules[moduleName].commands);

    modules.push({
      name: moduleName,
      commandStart,
      commandCount: commands.length - commandStart,
    });
  }

  const moduleRanges = new Map(modules.map((module) => [module.name, module]));
  for (const [alias, target] of Object.entries(MODULE_ALIASES)) {
    if (moduleRanges.has(alias)) continue;
    const targetRange = moduleRanges.get(target);
    if (!targetRange) continue;
    modules.push({
      name: alias,
      commandStart: targetRange.commandStart,
      commandCount: targetRange.commandCount,
    });
  }
  modules.sort((left, right) => left.name.localeCompare(right.name));

  return {
    basicCommandStart,
    basicCommandCount,
    modules,
    commands,
    items,
    globalCommands: [...globalCommands].sort(),
  };
}

function rows(values, render) {
  return values.map((value) => `  ${render(value)},`).join("\n");
}

function renderHeader(snapshot, tables) {
  return `/* Generated from schema/snapshot.json by scripts/generate-schema.js. */
#ifndef TREE_SITTER_SOFISTIK_SCHEMA_H_
#define TREE_SITTER_SOFISTIK_SCHEMA_H_

#include <stdint.h>

#define SOFISTIK_SCHEMA_DIGEST ${cString(snapshot.digest)}
#define SOFISTIK_UNKNOWN_ID UINT32_MAX

typedef struct {
  const char *name;
  uint32_t command_start;
  uint32_t command_count;
} SofistikModuleSchema;

typedef struct {
  const char *name;
  uint32_t item_start;
  uint32_t item_count;
} SofistikCommandSchema;

static const SofistikModuleSchema SOFISTIK_MODULES[] = {
${rows(tables.modules, (entry) => `{${cString(entry.name)}, ${entry.commandStart}, ${entry.commandCount}}`)}
};

static const SofistikCommandSchema SOFISTIK_COMMANDS[] = {
${rows(tables.commands, (entry) => `{${cString(entry.name)}, ${entry.itemStart}, ${entry.itemCount}}`)}
};

static const char *const SOFISTIK_ITEMS[] = {
${rows(tables.items, cString)}
};

static const char *const SOFISTIK_GLOBAL_COMMANDS[] = {
${rows(tables.globalCommands, cString)}
};

#define SOFISTIK_MODULE_COUNT ${tables.modules.length}u
#define SOFISTIK_BASIC_COMMAND_START ${tables.basicCommandStart}u
#define SOFISTIK_BASIC_COMMAND_COUNT ${tables.basicCommandCount}u
#define SOFISTIK_COMMAND_COUNT ${tables.commands.length}u
#define SOFISTIK_ITEM_COUNT ${tables.items.length}u
#define SOFISTIK_GLOBAL_COMMAND_COUNT ${tables.globalCommands.length}u

#endif
`;
}

function generateSchema(source = snapshotPath, output = outputPath) {
  const snapshot = JSON.parse(fs.readFileSync(source, "utf8"));
  const tables = buildTables(snapshot);
  const header = renderHeader(snapshot, tables);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, header);
  return tables;
}

if (require.main === module) {
  const tables = generateSchema();
  process.stdout.write(
    `Generated scanner tables for ${tables.modules.length} modules, ${tables.commands.length} commands, and ${tables.items.length} items.\n`,
  );
}

module.exports = {
  MODULE_ALIASES,
  UNIVERSAL_COMMANDS,
  buildTables,
  generateSchema,
  renderHeader,
};
