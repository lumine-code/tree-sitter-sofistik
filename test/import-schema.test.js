const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { importSchema, stableJson } = require("../scripts/import-schema");

function writeSchema(directory, file, modules) {
  fs.writeFileSync(path.join(directory, file), `${JSON.stringify(modules, null, 2)}\n`);
}

test("imports a deterministic union with provenance", (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-sofistik-"));
  const sourceDirectory = path.join(temporaryDirectory, "source");
  const outputDirectory = path.join(temporaryDirectory, "output");
  fs.mkdirSync(sourceDirectory);
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  writeSchema(sourceDirectory, "sofistik.2025.en.json", {
    AQUA: {
      CONC: {
        slots: [
          {
            position: 1,
            name: "NO",
            kind: "placeholder",
            dataTypeCode: "I",
            enumValues: [],
            enumRedirect: null,
          },
          {
            position: 2,
            name: "TYPE",
            kind: "enum",
            dataTypeCode: null,
            enumValues: ["C"],
            enumRedirect: null,
          },
        ],
      },
    },
  });
  writeSchema(sourceDirectory, "sofistik.2026.de.json", {
    modules: {
      AQUA: {
        commands: {
          CONC: {
            slots: [
              {
                position: 1,
                name: "NO",
                kind: "placeholder",
                dataTypeCode: "I",
                enumValues: [],
                enumRedirect: null,
              },
              {
                position: 2,
                name: "TYPE",
                kind: "enum",
                dataTypeCode: null,
                enumValues: ["C", "LC"],
                enumRedirect: null,
              },
            ],
          },
        },
      },
    },
  });
  writeSchema(sourceDirectory, "meta.json", {
    moduleAliases: { AQUA2: "AQUA" },
  });

  const first = importSchema(sourceDirectory, outputDirectory);
  const firstSnapshot = fs.readFileSync(path.join(outputDirectory, "snapshot.json"), "utf8");
  const second = importSchema(sourceDirectory, outputDirectory);
  const secondSnapshot = fs.readFileSync(path.join(outputDirectory, "snapshot.json"), "utf8");

  assert.strictEqual(firstSnapshot, secondSnapshot);
  assert.strictEqual(first.snapshot.digest, second.snapshot.digest);
  const { digest, ...semanticSnapshot } = first.snapshot;
  assert.strictEqual(
    digest,
    crypto.createHash("sha256").update(stableJson(semanticSnapshot)).digest("hex"),
  );
  assert.deepStrictEqual(first.snapshot.versions, ["2025", "2026"]);
  assert.deepStrictEqual(first.snapshot.languages, ["de", "en"]);
  assert.deepStrictEqual(first.snapshot.moduleAliases, { AQUA2: "AQUA" });
  assert.deepStrictEqual(first.snapshot.modules.AQUA.commands.CONC.items, ["NO", "TYPE"]);
  assert.deepStrictEqual(
    first.snapshot.modules.AQUA.commands.CONC.signatures[0].slots[1].enumValues,
    ["C", "LC"],
  );
  assert.strictEqual(first.provenance.sources.length, 2);
  assert.strictEqual(first.provenance.metadata.file, "meta.json");
  assert.deepStrictEqual(first.provenance.moduleAliases, { AQUA2: "AQUA" });
});

test("rejects malformed command schemas", (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-sofistik-"));
  const outputDirectory = path.join(temporaryDirectory, "output");
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  writeSchema(temporaryDirectory, "sofistik.2026.en.json", { AQUA: { CONC: [] } });

  assert.throws(
    () => importSchema(temporaryDirectory, outputDirectory),
    /AQUA\/CONC must contain slots/,
  );
});

test("rejects non-contiguous or zero-based slot positions", (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-sofistik-"));
  const outputDirectory = path.join(temporaryDirectory, "output");
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  for (const [position, message] of [
    [0, /invalid slot position/],
    [2, /slot positions must be contiguous and 1-based/],
  ]) {
    writeSchema(temporaryDirectory, "sofistik.2026.en.json", {
      AQUA: {
        CONC: {
          slots: [
            {
              position,
              name: "NO",
              kind: "keyword",
              dataTypeCode: null,
              enumValues: [],
              enumRedirect: null,
            },
          ],
        },
      },
    });
    assert.throws(() => importSchema(temporaryDirectory, outputDirectory), message);
  }
});

test("rejects aliases targeting modules absent from the schema", (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "tree-sitter-sofistik-"));
  const outputDirectory = path.join(temporaryDirectory, "output");
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  writeSchema(temporaryDirectory, "sofistik.2026.en.json", {
    AQUA: { HEAD: { slots: [] } },
  });
  writeSchema(temporaryDirectory, "meta.json", {
    moduleAliases: { UNKNOWN: "MISSING" },
  });

  assert.throws(
    () => importSchema(temporaryDirectory, outputDirectory),
    /module alias UNKNOWN targets unknown module MISSING/,
  );
});
