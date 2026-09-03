const fs = require("node:fs");
const path = require("node:path");
const { getGrammarVocabulary, getMetadata } = require("@lumine-code/sofistik-data");
const packageManifest = require("../package.json");

const root = path.join(__dirname, "..");
const outputPath = path.join(root, "src", "schema.h");
const provenancePath = path.join(root, "schema", "provenance.json");
const DATA_PACKAGE = "@lumine-code/sofistik-data";
const DATA_REPOSITORY = "https://github.com/lumine-code/sofistik-data";
const DATA_PIN_PATTERN = /^github:lumine-code\/sofistik-data#([a-f0-9]{40})$/;
const RESERVED_COMMANDS = new Set(["END", "ENDE"]);
const UNIVERSAL_COMMANDS = Object.freeze({
  HEAD: Object.freeze([]),
});

function cString(value) {
  return JSON.stringify(value);
}

function dataCommit(manifest = packageManifest) {
  const dependency = manifest.devDependencies?.[DATA_PACKAGE];
  const match = DATA_PIN_PATTERN.exec(dependency || "");
  if (!match) {
    throw new Error(
      `${DATA_PACKAGE} must be pinned to a full commit as github:lumine-code/sofistik-data#<sha>`,
    );
  }
  return match[1];
}

function buildProvenance(vocabulary, metadata, manifest = packageManifest) {
  if (vocabulary.digest !== metadata.grammarVocabularyDigest) {
    throw new Error(
      `Vocabulary digest ${vocabulary.digest} does not match metadata digest ${metadata.grammarVocabularyDigest}`,
    );
  }

  return {
    formatVersion: 1,
    source: {
      package: DATA_PACKAGE,
      repository: DATA_REPOSITORY,
      commit: dataCommit(manifest),
    },
    schemaDigest: metadata.schemaDigest,
    grammarVocabularyDigest: vocabulary.digest,
  };
}

function buildTables(vocabulary) {
  const basic = { ...UNIVERSAL_COMMANDS, ...vocabulary.modules.BASIC };
  const moduleNames = Object.keys(vocabulary.modules)
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
      const commandItems = commandMap[commandName];
      if (!Array.isArray(commandItems)) {
        throw new Error(`Expected ${commandName} items to be an array`);
      }
      const itemStart = items.length;
      globalCommands.add(commandName);

      items.push(...commandItems);
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
    appendCommands(vocabulary.modules[moduleName]);

    modules.push({
      name: moduleName,
      commandStart,
      commandCount: commands.length - commandStart,
    });
  }

  const moduleRanges = new Map(modules.map((module) => [module.name, module]));
  for (const [alias, target] of Object.entries(vocabulary.publicModuleAliases || {})) {
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

function renderHeader(provenance, tables) {
  return `/* Generated from ${DATA_PACKAGE} by scripts/generate-schema.js. */
#ifndef TREE_SITTER_SOFISTIK_SCHEMA_H_
#define TREE_SITTER_SOFISTIK_SCHEMA_H_

#include <stdint.h>

#define SOFISTIK_SCHEMA_DIGEST ${cString(provenance.schemaDigest)}
#define SOFISTIK_GRAMMAR_VOCABULARY_DIGEST ${cString(provenance.grammarVocabularyDigest)}
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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function generateSchema({
  vocabulary = getGrammarVocabulary(),
  metadata = getMetadata(),
  manifest = packageManifest,
  output = outputPath,
  provenanceOutput = provenancePath,
} = {}) {
  const provenance = buildProvenance(vocabulary, metadata, manifest);
  const tables = buildTables(vocabulary);
  const header = renderHeader(provenance, tables);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, header);
  writeJson(provenanceOutput, provenance);
  return { provenance, tables };
}

if (require.main === module) {
  const { provenance, tables } = generateSchema();
  process.stdout.write(
    `Generated scanner tables for ${tables.modules.length} modules, ${tables.commands.length} commands, and ${tables.items.length} items.\n`,
  );
  process.stdout.write(`Grammar vocabulary digest: ${provenance.grammarVocabularyDigest}\n`);
}

module.exports = {
  DATA_PACKAGE,
  DATA_REPOSITORY,
  UNIVERSAL_COMMANDS,
  buildProvenance,
  buildTables,
  dataCommit,
  generateSchema,
  renderHeader,
};
