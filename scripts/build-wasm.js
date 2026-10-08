const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const pinnedVersion = require("../package.json").devDependencies["tree-sitter-cli"];
const fleetPackage = path.join(
  root,
  "..",
  "lem",
  "node_modules",
  "tree-sitter-cli",
  "package.json",
);
const cliPackage =
  fs.existsSync(fleetPackage) && require(fleetPackage).version === pinnedVersion
    ? fleetPackage
    : require.resolve("tree-sitter-cli/package.json");
const cli = path.join(
  path.dirname(cliPackage),
  process.platform === "win32" ? "tree-sitter.exe" : "tree-sitter",
);
const { grammars } = require("../tree-sitter.json");

for (const { name, path: directory } of grammars) {
  const output =
    directory === "."
      ? path.join(root, "tree-sitter-sofistik.wasm")
      : path.join(root, directory, `${name.replaceAll("_", "-")}.wasm`);
  const result = spawnSync(cli, ["build", "--wasm", "-o", output, path.join(root, directory)], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
