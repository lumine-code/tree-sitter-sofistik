const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { getGrammarVocabulary, getMetadata } = require("@lumine-code/sofistik-data");
const packageManifest = require("../package.json");
const {
  DATA_PACKAGE,
  DATA_REPOSITORY,
  UNIVERSAL_COMMANDS,
  buildProvenance,
  buildTables,
  dataCommit,
  generateSchema,
} = require("../scripts/generate-schema");

const FIXTURE_COMMIT = "a".repeat(40);
const fixtureManifest = {
  devDependencies: {
    [DATA_PACKAGE]: `github:lumine-code/sofistik-data#${FIXTURE_COMMIT}`,
  },
};
const fixtureVocabulary = {
  formatVersion: 1,
  versions: ["2026"],
  languages: ["en"],
  publicModuleAliases: {},
  modules: {
    BASIC: {
      HEAD: ["TITL"],
      PAGE: ["UNII"],
    },
    AQUA: {
      CONC: ["NO", "TYPE"],
      HEAD: ["LOCAL"],
    },
    ASE: {},
  },
  digest: "fixture-vocabulary-digest",
};
const fixtureMetadata = {
  schemaDigest: "fixture-schema-digest",
  grammarVocabularyDigest: fixtureVocabulary.digest,
};

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

test("builds module-local scanner ranges with BASIC commands", () => {
  const tables = buildTables(fixtureVocabulary);
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

test("writes deterministic C tables and data provenance", (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-sofistik-"));
  const output = path.join(temporaryDirectory, "schema.h");
  const provenanceOutput = path.join(temporaryDirectory, "provenance.json");
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const options = {
    vocabulary: fixtureVocabulary,
    metadata: fixtureMetadata,
    manifest: fixtureManifest,
    output,
    provenanceOutput,
  };

  generateSchema(options);
  const firstHeader = fs.readFileSync(output, "utf8");
  const firstProvenance = fs.readFileSync(provenanceOutput, "utf8");
  generateSchema(options);

  assert.strictEqual(fs.readFileSync(output, "utf8"), firstHeader);
  assert.strictEqual(fs.readFileSync(provenanceOutput, "utf8"), firstProvenance);
  assert.match(firstHeader, /SOFISTIK_SCHEMA_DIGEST "fixture-schema-digest"/);
  assert.match(firstHeader, /SOFISTIK_GRAMMAR_VOCABULARY_DIGEST "fixture-vocabulary-digest"/);
  assert.match(firstHeader, /\{"AQUA", 2, 2\}/);
  assert.match(firstHeader, /SOFISTIK_BASIC_COMMAND_START 0u/);
  assert.match(firstHeader, /SOFISTIK_BASIC_COMMAND_COUNT 2u/);
  assert.match(firstHeader, /static const char \*const SOFISTIK_ITEMS\[\]/);
  assert.match(firstHeader, / {2}"TITL",\n {2}"UNII",\n {2}"NO",\n {2}"TYPE",\n {2}"LOCAL",/);
  assert.doesNotMatch(firstHeader, /SofistikItemSchema/);
  assert.doesNotMatch(firstHeader, /SOFISTIK_ENUM/);
  assert.doesNotMatch(firstHeader, /SOFISTIK_GLOBAL_ITEM/);
  assert.deepStrictEqual(JSON.parse(firstProvenance), {
    formatVersion: 1,
    source: {
      package: DATA_PACKAGE,
      repository: DATA_REPOSITORY,
      commit: FIXTURE_COMMIT,
    },
    schemaDigest: fixtureMetadata.schemaDigest,
    grammarVocabularyDigest: fixtureVocabulary.digest,
  });
});

test("preserves every command and item from the pinned grammar vocabulary", () => {
  const vocabulary = getGrammarVocabulary();
  const tables = buildTables(vocabulary);
  const basic = commandsInRange(tables, tables.basicCommandStart, tables.basicCommandCount);

  for (const module of tables.modules) {
    const local = commandsInRange(tables, module.commandStart, module.commandCount);
    const schemaModuleName = vocabulary.publicModuleAliases[module.name] || module.name;
    const expectedCommands = {
      ...UNIVERSAL_COMMANDS,
      ...vocabulary.modules.BASIC,
      ...vocabulary.modules[schemaModuleName],
    };
    delete expectedCommands.END;
    delete expectedCommands.ENDE;

    assert.deepStrictEqual(
      [...new Set([...basic.keys(), ...local.keys()])].sort(),
      Object.keys(expectedCommands).sort(),
      `${module.name} command names`,
    );
    for (const [commandName, commandItems] of Object.entries(expectedCommands)) {
      assert.deepStrictEqual(
        local.get(commandName) || basic.get(commandName),
        commandItems,
        `${module.name}/${commandName} items`,
      );
    }
  }
});

test("maps executable module names to their data ranges", () => {
  const vocabulary = getGrammarVocabulary();
  const tables = buildTables(vocabulary);
  const modules = new Map(tables.modules.map((module) => [module.name, module]));

  for (const [alias, target] of Object.entries(vocabulary.publicModuleAliases)) {
    assert.deepStrictEqual(
      {
        commandStart: modules.get(alias).commandStart,
        commandCount: modules.get(alias).commandCount,
      },
      {
        commandStart: modules.get(target).commandStart,
        commandCount: modules.get(target).commandCount,
      },
      `${alias} aliases ${target}`,
    );
  }
});

test("adds parser-specific universal HEAD vocabulary", () => {
  const vocabulary = getGrammarVocabulary();
  const tables = buildTables(vocabulary);
  const basic = commandsInRange(tables, tables.basicCommandStart, tables.basicCommandCount);

  assert.strictEqual("HEAD" in vocabulary.modules.BASIC, false);
  assert.deepStrictEqual(basic.get("HEAD"), []);
});

test("records the exact data pin and both semantic digests", () => {
  const vocabulary = getGrammarVocabulary();
  const metadata = getMetadata();
  const provenance = buildProvenance(vocabulary, metadata);

  assert.strictEqual(dataCommit(), "c2ea4651db138f6aec1b9079df2e0f8539f52d1e");
  assert.strictEqual(provenance.source.repository, DATA_REPOSITORY);
  assert.strictEqual(provenance.source.commit, dataCommit(packageManifest));
  assert.strictEqual(provenance.schemaDigest, metadata.schemaDigest);
  assert.strictEqual(provenance.grammarVocabularyDigest, vocabulary.digest);
  assert.strictEqual(vocabulary.digest, metadata.grammarVocabularyDigest);
});

test("rejects mutable data references and mismatched vocabulary", () => {
  assert.throws(
    () => dataCommit({ devDependencies: { [DATA_PACKAGE]: "^1.0.0" } }),
    /must be pinned to a full commit/,
  );
  assert.throws(
    () =>
      buildProvenance(
        { ...fixtureVocabulary, digest: "different" },
        fixtureMetadata,
        fixtureManifest,
      ),
    /does not match metadata digest/,
  );
});

test("keeps native builds independent from generation dependencies", () => {
  assert.strictEqual(packageManifest.scripts.build, "npm run build:native");
  assert.doesNotMatch(packageManifest.scripts.build, /generate/);
  assert.match(packageManifest.scripts.generate, /generate:schema/);
  assert.strictEqual("import:schema" in packageManifest.scripts, false);
  assert.strictEqual(packageManifest.files.includes("schema/snapshot.json"), false);
});
