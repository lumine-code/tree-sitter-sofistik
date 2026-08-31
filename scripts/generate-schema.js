const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const snapshotPath = path.join(root, "schema", "snapshot.json");
const outputPath = path.join(root, "src", "schema.h");
const RESERVED_COMMANDS = new Set(["END", "ENDE"]);

function cString(value) {
  return JSON.stringify(value).replace(/\\u([0-9a-f]{4})/gi, "\\u$1");
}

function enumValuesForItem(command, itemName) {
  const values = [];
  for (const signature of command.signatures) {
    for (const slot of signature.slots) {
      if (slot.name === itemName) values.push(...slot.enumValues);
    }
  }
  return [...new Set(values)].sort();
}

function buildTables(snapshot) {
  const basic = snapshot.modules.BASIC?.commands || {};
  const moduleNames = Object.keys(snapshot.modules)
    .filter((name) => name !== "BASIC")
    .sort();
  const modules = [];
  const commands = [];
  const items = [];
  const enums = [];
  const globalCommands = new Set();
  const globalItems = new Set();

  for (const moduleName of moduleNames) {
    const moduleCommands = { ...basic, ...snapshot.modules[moduleName].commands };
    const names = Object.keys(moduleCommands)
      .filter((name) => !RESERVED_COMMANDS.has(name))
      .sort();
    const commandStart = commands.length;

    for (const commandName of names) {
      const command = moduleCommands[commandName];
      const itemStart = items.length;
      globalCommands.add(commandName);

      for (const itemName of command.items) {
        const enumStart = enums.length;
        const values = enumValuesForItem(command, itemName);
        enums.push(...values);
        items.push({
          name: itemName,
          enumStart,
          enumCount: values.length,
        });
        globalItems.add(itemName);
      }

      commands.push({
        name: commandName,
        itemStart,
        itemCount: items.length - itemStart,
      });
    }

    modules.push({
      name: moduleName,
      commandStart,
      commandCount: commands.length - commandStart,
    });
  }

  return {
    modules,
    commands,
    items,
    enums,
    globalCommands: [...globalCommands].sort(),
    globalItems: [...globalItems].sort(),
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

typedef struct {
  const char *name;
  uint32_t enum_start;
  uint32_t enum_count;
} SofistikItemSchema;

static const SofistikModuleSchema SOFISTIK_MODULES[] = {
${rows(tables.modules, (entry) => `{${cString(entry.name)}, ${entry.commandStart}, ${entry.commandCount}}`)}
};

static const SofistikCommandSchema SOFISTIK_COMMANDS[] = {
${rows(tables.commands, (entry) => `{${cString(entry.name)}, ${entry.itemStart}, ${entry.itemCount}}`)}
};

static const SofistikItemSchema SOFISTIK_ITEMS[] = {
${rows(tables.items, (entry) => `{${cString(entry.name)}, ${entry.enumStart}, ${entry.enumCount}}`)}
};

static const char *const SOFISTIK_ENUMS[] = {
${rows(tables.enums, cString)}
};

static const char *const SOFISTIK_GLOBAL_COMMANDS[] = {
${rows(tables.globalCommands, cString)}
};

static const char *const SOFISTIK_GLOBAL_ITEMS[] = {
${rows(tables.globalItems, cString)}
};

#define SOFISTIK_MODULE_COUNT ${tables.modules.length}u
#define SOFISTIK_COMMAND_COUNT ${tables.commands.length}u
#define SOFISTIK_ITEM_COUNT ${tables.items.length}u
#define SOFISTIK_ENUM_COUNT ${tables.enums.length}u
#define SOFISTIK_GLOBAL_COMMAND_COUNT ${tables.globalCommands.length}u
#define SOFISTIK_GLOBAL_ITEM_COUNT ${tables.globalItems.length}u

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
    `Generated scanner tables for ${tables.modules.length} modules, ${tables.commands.length} commands, ${tables.items.length} items, and ${tables.enums.length} enum values.\n`,
  );
}

module.exports = {
  buildTables,
  generateSchema,
  renderHeader,
};
