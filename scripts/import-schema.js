const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCHEMA_FILE_PATTERN = /^sofistik\.(\d{4})\.(en|de)\.json$/;
const SOURCE_REPOSITORY = "https://github.com/lumine-code/language-sofistik";
const ALLOWED_SLOT_KINDS = new Set(["keyword", "literal", "enum", "comment", "placeholder"]);

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableObject(value[key])]),
  );
}

function stableJson(value) {
  return `${JSON.stringify(stableObject(value), null, 2)}\n`;
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readModuleAliases(sourceDirectory, modules) {
  const file = "meta.json";
  const metaPath = path.join(sourceDirectory, file);
  if (!fs.existsSync(metaPath)) return { aliases: {}, source: null };

  const content = fs.readFileSync(metaPath, "utf8");
  const metadata = JSON.parse(content);
  const rawAliases = metadata.moduleAliases || {};
  if (typeof rawAliases !== "object" || Array.isArray(rawAliases)) {
    throw new Error(`${file}: moduleAliases must be an object`);
  }

  const aliases = {};
  for (const [rawAlias, rawTarget] of Object.entries(rawAliases).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const alias = String(rawAlias).toUpperCase();
    const target = String(rawTarget).toUpperCase();
    if (!modules[target]) {
      throw new Error(`${file}: module alias ${alias} targets unknown module ${target}`);
    }
    if (modules[alias] && alias !== target) {
      throw new Error(`${file}: module alias ${alias} conflicts with a schema module`);
    }
    aliases[alias] = target;
  }
  return { aliases, source: { file, digest: digest(content) } };
}

function sourceModules(document) {
  if (document && typeof document === "object" && document.modules) {
    return document.modules;
  }
  return document;
}

function commandMap(moduleDocument) {
  if (moduleDocument && typeof moduleDocument === "object" && moduleDocument.commands) {
    return moduleDocument.commands;
  }
  return moduleDocument;
}

function normalizeSlot(slot, sourceName, moduleName, commandName) {
  if (!slot || typeof slot !== "object") {
    throw new Error(`${sourceName}: ${moduleName}/${commandName} has a non-object slot`);
  }

  const position = Number(slot.position);
  if (!Number.isInteger(position) || position < 1) {
    throw new Error(`${sourceName}: ${moduleName}/${commandName} has invalid slot position`);
  }

  const name =
    slot.name === null || slot.name === undefined ? null : String(slot.name).toUpperCase();
  const kind = String(slot.kind || "placeholder");
  if (!ALLOWED_SLOT_KINDS.has(kind)) {
    throw new Error(
      `${sourceName}: ${moduleName}/${commandName} has unsupported slot kind ${kind}`,
    );
  }

  const enumRedirect = slot.enumRedirect
    ? {
        command: String(slot.enumRedirect.command).toUpperCase(),
        item: String(slot.enumRedirect.item).toUpperCase(),
      }
    : null;

  return {
    position,
    name,
    kind,
    dataTypeCode:
      slot.dataTypeCode === null || slot.dataTypeCode === undefined
        ? null
        : String(slot.dataTypeCode),
    enumValues: [
      ...new Set((slot.enumValues || []).map((value) => String(value).toUpperCase())),
    ].sort(),
    enumRedirect,
  };
}

function structuralSignature(slots) {
  return JSON.stringify(slots.map(({ enumValues: _enumValues, ...slot }) => slot));
}

function mergeSchemaFiles(files) {
  const modules = {};
  const versions = new Set();
  const languages = new Set();
  const sources = [];

  for (const file of files) {
    const match = SCHEMA_FILE_PATTERN.exec(file.name);
    if (!match) continue;

    const [, version, language] = match;
    versions.add(version);
    languages.add(language);
    const content = fs.readFileSync(file.path, "utf8");
    const document = JSON.parse(content);
    const documentModules = sourceModules(document);

    if (!documentModules || typeof documentModules !== "object" || Array.isArray(documentModules)) {
      throw new Error(`${file.name}: expected an object containing modules`);
    }

    sources.push({ file: file.name, version, language, digest: digest(content) });

    for (const [rawModuleName, moduleDocument] of Object.entries(documentModules)) {
      const moduleName = rawModuleName.toUpperCase();
      const commands = commandMap(moduleDocument);
      if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
        throw new Error(`${file.name}: ${moduleName} must contain a command object`);
      }

      modules[moduleName] ||= { commands: {} };
      for (const [rawCommandName, commandDocument] of Object.entries(commands)) {
        const commandName = rawCommandName.toUpperCase();
        if (!commandDocument || !Array.isArray(commandDocument.slots)) {
          throw new Error(`${file.name}: ${moduleName}/${commandName} must contain slots`);
        }

        const slots = commandDocument.slots
          .map((slot) => normalizeSlot(slot, file.name, moduleName, commandName))
          .sort((left, right) => left.position - right.position);
        for (let index = 0; index < slots.length; index++) {
          if (slots[index].position !== index + 1) {
            throw new Error(
              `${file.name}: ${moduleName}/${commandName} slot positions must be contiguous and 1-based`,
            );
          }
        }
        const key = structuralSignature(slots);
        const target = (modules[moduleName].commands[commandName] ||= {
          items: [],
          signatures: [],
        });
        let signature = target.signatures.find((candidate) => candidate.key === key);

        if (!signature) {
          signature = {
            key,
            slots: slots.map((slot) => ({ ...slot })),
            sources: [],
          };
          target.signatures.push(signature);
        } else {
          for (let index = 0; index < slots.length; index++) {
            signature.slots[index].enumValues = [
              ...new Set([...signature.slots[index].enumValues, ...slots[index].enumValues]),
            ].sort();
          }
        }

        signature.sources.push({ version, language });
        target.items.push(...slots.map((slot) => slot.name).filter(Boolean));
      }
    }
  }

  for (const module of Object.values(modules)) {
    for (const command of Object.values(module.commands)) {
      command.items = [...new Set(command.items)].sort();
      command.signatures.sort((left, right) => left.key.localeCompare(right.key));
      for (const signature of command.signatures) {
        delete signature.key;
        signature.sources.sort(
          (left, right) =>
            left.version.localeCompare(right.version) ||
            left.language.localeCompare(right.language),
        );
      }
    }
  }

  return {
    modules,
    versions: [...versions].sort(),
    languages: [...languages].sort(),
    sources: sources.sort((left, right) => left.file.localeCompare(right.file)),
  };
}

function gitValue(sourceDirectory, args, fallback) {
  try {
    return execFileSync("git", ["-C", sourceDirectory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function importSchema(sourceDirectory, outputDirectory) {
  const absoluteSource = path.resolve(sourceDirectory);
  const absoluteOutput = path.resolve(outputDirectory);
  const files = fs
    .readdirSync(absoluteSource, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SCHEMA_FILE_PATTERN.test(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(absoluteSource, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (files.length === 0) {
    throw new Error(`No sofistik.<version>.<language>.json files found in ${absoluteSource}`);
  }

  const merged = mergeSchemaFiles(files);
  const aliasMetadata = readModuleAliases(absoluteSource, merged.modules);
  const semanticSnapshot = {
    schemaVersion: 1,
    versions: merged.versions,
    languages: merged.languages,
    moduleAliases: aliasMetadata.aliases,
    modules: merged.modules,
  };
  const snapshotDigest = digest(stableJson(semanticSnapshot));
  const snapshot = { ...semanticSnapshot, digest: snapshotDigest };
  const provenance = {
    schemaVersion: 1,
    source: {
      repository: SOURCE_REPOSITORY,
      commit: gitValue(absoluteSource, ["rev-parse", "HEAD"], "unknown"),
      dirty: Boolean(gitValue(absoluteSource, ["status", "--porcelain", "--", "."], "")),
    },
    versions: merged.versions,
    languages: merged.languages,
    moduleAliases: aliasMetadata.aliases,
    metadata: aliasMetadata.source,
    sources: merged.sources,
    digest: snapshotDigest,
  };

  fs.mkdirSync(absoluteOutput, { recursive: true });
  fs.writeFileSync(path.join(absoluteOutput, "snapshot.json"), stableJson(snapshot));
  fs.writeFileSync(path.join(absoluteOutput, "provenance.json"), stableJson(provenance));
  return { snapshot, provenance };
}

function parseArguments(argv) {
  let sourceDirectory = null;
  let outputDirectory = path.join(__dirname, "..", "schema");

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--output") {
      outputDirectory = argv[++index];
    } else if (!sourceDirectory) {
      sourceDirectory = argv[index];
    } else {
      throw new Error(`Unexpected argument: ${argv[index]}`);
    }
  }

  if (!sourceDirectory) {
    throw new Error("Usage: import-schema <language-sofistik/schema> [--output <directory>]");
  }
  return { sourceDirectory, outputDirectory };
}

if (require.main === module) {
  try {
    const { sourceDirectory, outputDirectory } = parseArguments(process.argv.slice(2));
    const { snapshot, provenance } = importSchema(sourceDirectory, outputDirectory);
    const commandCount = Object.values(snapshot.modules).reduce(
      (sum, module) => sum + Object.keys(module.commands).length,
      0,
    );
    process.stdout.write(
      `Imported ${Object.keys(snapshot.modules).length} modules and ${commandCount} commands from ${provenance.sources.length} schema files.\n`,
    );
    process.stdout.write(`Snapshot digest: ${snapshot.digest}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  importSchema,
  mergeSchemaFiles,
  readModuleAliases,
  stableJson,
};
