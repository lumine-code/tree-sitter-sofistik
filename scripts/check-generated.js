const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(process.execPath, [path.join(root, "scripts", "generate-schema.js")]);
run(process.execPath, [require.resolve("tree-sitter-cli/cli.js"), "generate"]);
run("git", [
  "diff",
  "--exit-code",
  "--",
  "src/grammar.json",
  "src/node-types.json",
  "src/parser.c",
  "src/schema.h",
]);
