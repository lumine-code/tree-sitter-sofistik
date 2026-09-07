const fs = require("node:fs");
const path = require("node:path");
const {
  getGrammarVocabulary,
  getMetadata,
  provider: getDataProvider,
} = require("@lumine-code/sofistik-data");
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
  KOPF: Object.freeze([]),
  UNIT: Object.freeze([]),
});
const COMMAND_OVERRIDES = Object.freeze({
  DYNA: Object.freeze({ TEST: Object.freeze([]) }),
});
const COMMAND_VALUE_OVERRIDES = Object.freeze({
  AQUA: Object.freeze({
    BLEC: Object.freeze(["TOPL"]),
    LNAH: Object.freeze(["TOPL"]),
    PLAT: Object.freeze(["TOPL"]),
    WELD: Object.freeze(["TOPL"]),
  }),
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

function buildResolverVocabulary(dataProvider = getDataProvider()) {
  const metadata = dataProvider.getMetadata();
  const modules = new Map();

  for (const version of metadata.versions) {
    for (const language of metadata.languages) {
      const schema = dataProvider.loadSchemas(version, language);
      for (const [moduleName, commands] of Object.entries(schema)) {
        if (!modules.has(moduleName)) modules.set(moduleName, new Map());
        const module = modules.get(moduleName);
        for (const [commandName, command] of Object.entries(commands)) {
          if (!module.has(commandName)) module.set(commandName, new Set());
          const values = module.get(commandName);
          for (const form of command.forms) {
            for (const slot of form.slots) {
              for (const value of slot.enumValues) values.add(String(value).toUpperCase());
            }
          }
        }
      }
    }
  }

  return Object.fromEntries(
    [...modules].map(([moduleName, commands]) => [
      moduleName,
      Object.fromEntries(
        [...commands].map(([commandName, values]) => [commandName, [...values].sort()]),
      ),
    ]),
  );
}

function buildTables(vocabulary, resolverVocabulary = {}) {
  const basic = { ...UNIVERSAL_COMMANDS, ...vocabulary.modules.BASIC };
  const moduleNames = Object.keys(vocabulary.modules)
    .filter((name) => name !== "BASIC")
    .sort();
  const modules = [];
  const commands = [];
  const items = [];
  const commandValues = [];
  const globalCommands = new Set(Object.keys(basic));
  for (const [moduleName, commandMap] of Object.entries(vocabulary.modules)) {
    for (const commandName of Object.keys({
      ...(COMMAND_OVERRIDES[moduleName] || {}),
      ...commandMap,
    })) {
      globalCommands.add(commandName);
    }
  }

  function appendCommands(commandMap, resolverCommandMap = {}) {
    const names = Object.keys(commandMap)
      .filter((name) => !RESERVED_COMMANDS.has(name))
      .sort();

    for (const commandName of names) {
      const commandItems = commandMap[commandName];
      if (!Array.isArray(commandItems)) {
        throw new Error(`Expected ${commandName} items to be an array`);
      }
      const itemStart = items.length;
      const valueStart = commandValues.length;
      const resolverValues = resolverCommandMap[commandName] || [];

      items.push(...commandItems);
      commandValues.push(...resolverValues.filter((value) => globalCommands.has(value)));
      commands.push({
        name: commandName,
        itemStart,
        itemCount: items.length - itemStart,
        valueStart,
        valueCount: commandValues.length - valueStart,
      });
    }
  }

  const basicCommandStart = commands.length;
  appendCommands(basic, resolverVocabulary.BASIC);
  const basicCommandCount = commands.length - basicCommandStart;

  for (const moduleName of moduleNames) {
    const commandStart = commands.length;
    const commandMap = {
      ...(COMMAND_OVERRIDES[moduleName] || {}),
      ...vocabulary.modules[moduleName],
    };
    const resolverCommandMap = { ...(resolverVocabulary[moduleName] || {}) };
    for (const [commandName, values] of Object.entries(COMMAND_VALUE_OVERRIDES[moduleName] || {})) {
      resolverCommandMap[commandName] = [
        ...new Set([...(resolverCommandMap[commandName] || []), ...values]),
      ].sort();
    }
    appendCommands(commandMap, resolverCommandMap);

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
    commandValues,
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
  uint32_t value_start;
  uint32_t value_count;
} SofistikCommandSchema;

static const SofistikModuleSchema SOFISTIK_MODULES[] = {
${rows(tables.modules, (entry) => `{${cString(entry.name)}, ${entry.commandStart}, ${entry.commandCount}}`)}
};

static const SofistikCommandSchema SOFISTIK_COMMANDS[] = {
${rows(tables.commands, (entry) => `{${cString(entry.name)}, ${entry.itemStart}, ${entry.itemCount}, ${entry.valueStart}, ${entry.valueCount}}`)}
};

static const char *const SOFISTIK_ITEMS[] = {
${rows(tables.items, cString)}
};

static const char *const SOFISTIK_COMMAND_VALUES[] = {
${rows(tables.commandValues, cString)}
};

static const char *const SOFISTIK_GLOBAL_COMMANDS[] = {
${rows(tables.globalCommands, cString)}
};

#define SOFISTIK_MODULE_COUNT ${tables.modules.length}u
#define SOFISTIK_BASIC_COMMAND_START ${tables.basicCommandStart}u
#define SOFISTIK_BASIC_COMMAND_COUNT ${tables.basicCommandCount}u
#define SOFISTIK_COMMAND_COUNT ${tables.commands.length}u
#define SOFISTIK_ITEM_COUNT ${tables.items.length}u
#define SOFISTIK_COMMAND_VALUE_COUNT ${tables.commandValues.length}u
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
  resolverVocabulary = buildResolverVocabulary(),
  metadata = getMetadata(),
  manifest = packageManifest,
  output = outputPath,
  provenanceOutput = provenancePath,
} = {}) {
  const provenance = buildProvenance(vocabulary, metadata, manifest);
  const tables = buildTables(vocabulary, resolverVocabulary);
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
  COMMAND_OVERRIDES,
  COMMAND_VALUE_OVERRIDES,
  UNIVERSAL_COMMANDS,
  buildProvenance,
  buildResolverVocabulary,
  buildTables,
  dataCommit,
  generateSchema,
  renderHeader,
};
