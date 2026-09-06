const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Parser = require("tree-sitter");
const SOFiSTiK = require("..");
const {
  source: data,
  schemaDigest,
  grammarVocabularyDigest,
} = require("../schema/provenance.json");

const TRACKED_NODE_TYPES = Object.freeze([
  "cdb_statement",
  "command",
  "formatted_value",
  "hash_variable",
  "if_block",
  "invalid_command",
  "invalid_at_reference",
  "literal_hash",
  "loop_block",
  "number",
  "number_list",
  "orphan_endloop_record",
  "orphan_endif_record",
  "orphan_text_end",
  "picture_block",
  "punctuated_value",
  "string",
  "unterminated_double_quoted_string",
  "unterminated_input_block",
  "unterminated_single_quoted_string",
]);
const DYNAMIC_CONTROL_WORDS = new Set(["ELSE", "ELSEIF", "ENDIF", "ENDLOOP", "IF", "LOOP"]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(file, files);
    else if (path.extname(entry.name).toLowerCase() === ".dat") files.push(file);
  }
  return files;
}

function collectFailures(node, failures = []) {
  if (node.type === "ERROR") {
    failures.push({ type: "ERROR", node });
    return failures;
  }
  if (node.isMissing) {
    failures.push({ type: `MISSING:${node.type}`, node });
    return failures;
  }
  for (const child of node.children) collectFailures(child, failures);
  return failures;
}

function normalizeEncoding(encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).encoding;
  } catch {
    throw new Error(`Unsupported fallback encoding: ${encoding}`);
  }
}

function decode(buffer, fallbackEncodings = []) {
  if (buffer.includes(0)) return { skipped: "nul" };

  const encodings = ["utf-8", ...fallbackEncodings];
  for (const [index, encoding] of encodings.entries()) {
    const decoder = new TextDecoder(encoding, { fatal: true });
    try {
      const source = decoder.decode(buffer);
      return index === 0 ? { source } : { source, encoding: decoder.encoding };
    } catch {
      continue;
    }
  }

  return { skipped: "invalidUtf8" };
}

function normalize(file) {
  return file.split(path.sep).join("/");
}

function hasProgramHeader(source) {
  return /^[ \t]*[+\-$]?PROG\b/im.test(source);
}

function hasCorpusFailures(summary) {
  return summary.badFiles > 0 || summary.skipped.invalidUtf8 > 0;
}

function parseArguments(argv, environment = process.env) {
  const positional = [];
  const fallbackEncodings = [];
  let optionsEnded = false;
  let help = false;
  let structure = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!optionsEnded && argument === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && (argument === "--help" || argument === "-h")) {
      help = true;
    } else if (!optionsEnded && argument === "--structure") {
      structure = true;
    } else if (!optionsEnded && argument === "--fallback-encoding") {
      const encoding = argv[++index];
      if (encoding === undefined || encoding.length === 0) {
        throw new Error("--fallback-encoding requires an encoding");
      }
      fallbackEncodings.push(normalizeEncoding(encoding));
    } else if (!optionsEnded && argument.startsWith("--fallback-encoding=")) {
      const encoding = argument.slice("--fallback-encoding=".length);
      if (encoding.length === 0) {
        throw new Error("--fallback-encoding requires an encoding");
      }
      fallbackEncodings.push(normalizeEncoding(encoding));
    } else if (!optionsEnded && argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length > 1) {
    throw new Error("Expected a single corpus directory");
  }

  return {
    root: positional[0] || environment.SOFISTIK_CORPUS,
    fallbackEncodings,
    help,
    structure,
  };
}

function fingerprintFailure(file, failure) {
  return {
    file: normalize(file),
    row: failure.node.startPosition.row + 1,
    column: failure.node.startPosition.column + 1,
    endRow: failure.node.endPosition.row + 1,
    endColumn: failure.node.endPosition.column + 1,
    type: failure.type,
  };
}

function collectStructure(root, summary, file = "") {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Object.hasOwn(summary.nodeCounts, node.type)) {
      summary.nodeCounts[node.type]++;
    }
    if (node.type === "dynamic_command_name") {
      const word = node.text.toUpperCase();
      if (DYNAMIC_CONTROL_WORDS.has(word)) {
        summary.dynamicControlCommands[word] = (summary.dynamicControlCommands[word] || 0) + 1;
      }
    } else if (node.type === "invalid_command") {
      const word = node.text.toUpperCase();
      summary.invalidCommands[word] = (summary.invalidCommands[word] || 0) + 1;
      summary.invalidCommandFingerprints.push({
        file,
        row: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        text: node.text,
      });
      if (word === "KOPF") summary.invalidKopf++;
    }
    const children = node.namedChildren || node.children || [];
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push(children[index]);
    }
  }
}

function run(root, { fallbackEncodings = [], output = true, structure = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const files = collectFiles(absoluteRoot).sort(compareText);
  const parser = new Parser();
  parser.setLanguage(SOFiSTiK);
  const summary = {
    root: absoluteRoot,
    data,
    schemaDigest,
    grammarVocabularyDigest,
    discovered: files.length,
    parsed: 0,
    skipped: { nul: 0, invalidUtf8: 0 },
    skippedFiles: [],
    fallbackFiles: [],
    fallbackEncodings,
    badFiles: 0,
    errorNodes: 0,
    classifications: {},
    fileClassifications: {
      fragmentWithoutProgram: { files: 0, errorNodes: 0 },
      documentWithUnsupportedSyntax: { files: 0, errorNodes: 0 },
    },
    firstFailures: [],
    failureFingerprints: [],
    elapsedMs: 0,
  };
  if (structure) {
    summary.nodeCounts = Object.fromEntries(TRACKED_NODE_TYPES.map((type) => [type, 0]));
    summary.dynamicControlCommands = {};
    summary.invalidCommands = {};
    summary.invalidCommandFingerprints = [];
    summary.invalidKopf = 0;
  }
  const started = performance.now();

  for (const file of files) {
    const relativeFile = normalize(path.relative(absoluteRoot, file));
    const decoded = decode(fs.readFileSync(file), fallbackEncodings);
    if (decoded.skipped) {
      summary.skipped[decoded.skipped]++;
      summary.skippedFiles.push({ file: relativeFile, reason: decoded.skipped });
      continue;
    }

    summary.parsed++;
    if (decoded.encoding) {
      summary.fallbackFiles.push({ file: relativeFile, encoding: decoded.encoding });
    }
    const tree = parser.parse(decoded.source);
    if (structure) {
      collectStructure(tree.rootNode, summary, relativeFile);
    }
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
      summary.failureFingerprints.push(fingerprintFailure(relativeFile, failure));
    }
    if (summary.firstFailures.length < 20) {
      const failure = failures[0];
      summary.firstFailures.push({
        file: relativeFile,
        row: failure.node.startPosition.row + 1,
        column: failure.node.startPosition.column + 1,
        type: failure.type,
      });
    }
  }

  summary.elapsedMs = Math.round(performance.now() - started);
  summary.classifications = Object.fromEntries(
    Object.entries(summary.classifications).sort(([left], [right]) => compareText(left, right)),
  );
  if (structure) {
    summary.invalidCommands = Object.fromEntries(
      Object.entries(summary.invalidCommands).sort(([left], [right]) => compareText(left, right)),
    );
    summary.invalidCommandFingerprints.sort(
      (left, right) =>
        compareText(left.file, right.file) ||
        left.row - right.row ||
        left.column - right.column ||
        compareText(left.text, right.text),
    );
  }
  if (output) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  if (hasCorpusFailures(summary)) process.exitCode = 1;
  return summary;
}

if (require.main === module) {
  const usage =
    "Usage: npm run test:corpus -- [--fallback-encoding <encoding>]... [--structure] <directory>\n";
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage);
    } else if (!options.root) {
      process.stderr.write(usage);
      process.exitCode = 2;
    } else {
      run(options.root, options);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage}`);
    process.exitCode = 2;
  }
}

module.exports = {
  TRACKED_NODE_TYPES,
  collectFailures,
  collectFiles,
  collectStructure,
  decode,
  fingerprintFailure,
  hasCorpusFailures,
  hasProgramHeader,
  parseArguments,
  run,
};
