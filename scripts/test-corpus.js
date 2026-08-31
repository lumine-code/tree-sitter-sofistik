const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Parser = require("tree-sitter");
const SOFiSTiK = require("..");

function collectFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(file, files);
    else if (path.extname(entry.name).toLowerCase() === ".dat") files.push(file);
  }
  return files;
}

function collectFailures(node, failures = []) {
  if (node.type === "ERROR") failures.push({ type: "ERROR", node });
  else if (node.isMissing) failures.push({ type: `MISSING:${node.type}`, node });
  for (const child of node.children) collectFailures(child, failures);
  return failures;
}

function decode(buffer) {
  if (buffer.includes(0)) return { skipped: "nul" };
  try {
    return { source: new TextDecoder("utf-8", { fatal: true }).decode(buffer) };
  } catch {
    return { skipped: "invalidUtf8" };
  }
}

function normalize(file) {
  return file.split(path.sep).join("/");
}

function hasProgramHeader(source) {
  return /^[ \t]*[+\-$]?PROG\b/im.test(source);
}

function run(root) {
  const absoluteRoot = path.resolve(root);
  const files = collectFiles(absoluteRoot).sort((left, right) => left.localeCompare(right));
  const parser = new Parser();
  parser.setLanguage(SOFiSTiK);
  const summary = {
    root: absoluteRoot,
    discovered: files.length,
    parsed: 0,
    skipped: { nul: 0, invalidUtf8: 0 },
    badFiles: 0,
    errorNodes: 0,
    classifications: {},
    fileClassifications: {
      fragmentWithoutProgram: { files: 0, errorNodes: 0 },
      documentWithUnsupportedSyntax: { files: 0, errorNodes: 0 },
    },
    firstFailures: [],
    elapsedMs: 0,
  };
  const started = performance.now();

  for (const file of files) {
    const decoded = decode(fs.readFileSync(file));
    if (decoded.skipped) {
      summary.skipped[decoded.skipped]++;
      continue;
    }

    summary.parsed++;
    const tree = parser.parse(decoded.source);
    if (!tree.rootNode.hasError) continue;
    summary.badFiles++;
    const failures = collectFailures(tree.rootNode);
    if (failures.length === 0) failures.push({ type: "UNLOCATED", node: tree.rootNode });
    summary.errorNodes += failures.length;
    const fileClassification = hasProgramHeader(decoded.source)
      ? "documentWithUnsupportedSyntax"
      : "fragmentWithoutProgram";
    summary.fileClassifications[fileClassification].files++;
    summary.fileClassifications[fileClassification].errorNodes += failures.length;

    for (const failure of failures) {
      summary.classifications[failure.type] = (summary.classifications[failure.type] || 0) + 1;
    }
    if (summary.firstFailures.length < 20) {
      const failure = failures[0];
      summary.firstFailures.push({
        file: normalize(path.relative(absoluteRoot, file)),
        row: failure.node.startPosition.row + 1,
        column: failure.node.startPosition.column + 1,
        type: failure.type,
      });
    }
  }

  summary.elapsedMs = Math.round(performance.now() - started);
  summary.classifications = Object.fromEntries(
    Object.entries(summary.classifications).sort(([left], [right]) => left.localeCompare(right)),
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.badFiles > 0) process.exitCode = 1;
  return summary;
}

if (require.main === module) {
  const root = process.argv[2] || process.env.SOFISTIK_CORPUS;
  if (!root) {
    process.stderr.write("Usage: npm run test:corpus -- <directory>\n");
    process.exitCode = 2;
  } else {
    run(root);
  }
}

module.exports = { collectFailures, collectFiles, decode, hasProgramHeader, run };
