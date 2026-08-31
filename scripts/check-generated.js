const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(npm, ["run", "generate", "--silent"]);
run("git", [
  "diff",
  "--exit-code",
  "--",
  "src/grammar.json",
  "src/node-types.json",
  "src/parser.c",
]);
