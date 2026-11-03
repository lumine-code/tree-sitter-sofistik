const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const cli = require.resolve("tree-sitter-cli/cli.js");

for (const directory of [".", "def"]) {
  const result = spawnSync(process.execPath, [cli, "generate"], {
    cwd: path.join(root, directory),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
