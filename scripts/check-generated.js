const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { generateSchema } = require("./generate-schema");

const root = path.join(__dirname, "..");
const generatedFiles = [
  ["src/grammar.json", "grammar.json"],
  ["src/node-types.json", "node-types.json"],
  ["src/parser.c", "parser.c"],
  ["src/schema.h", "schema.h"],
  ["schema/provenance.json", "provenance.json"],
];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "tree-sitter-sofistik-generated-"),
);

try {
  generateSchema({
    output: path.join(temporaryDirectory, "schema.h"),
    provenanceOutput: path.join(temporaryDirectory, "provenance.json"),
  });
  run(process.execPath, [
    require.resolve("tree-sitter-cli/cli.js"),
    "generate",
    "--output",
    temporaryDirectory,
    path.join(root, "grammar.js"),
  ]);

  const staleFiles = generatedFiles.filter(([expectedFile, generatedFile]) => {
    const expected = fs.readFileSync(path.join(root, expectedFile));
    const generated = fs.readFileSync(path.join(temporaryDirectory, generatedFile));
    return !expected.equals(generated);
  });

  if (staleFiles.length > 0) {
    process.stderr.write(
      `Generated files are stale: ${staleFiles.map(([file]) => file).join(", ")}\n`,
    );
    process.stderr.write("Run `npm run generate` and commit the resulting files.\n");
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
