const assert = require("node:assert/strict");

// Public documentation examples and synthetic edge cases checked against the
// SOFiSTiK 2026 definition-file reader. These are DEF lines, not CADINP records.
const cases = [
  {
    name: "documented environment settings",
    source: "SOFISTIK_C=49\nGRAFSIZE=SIZE -HP 0\nHEAD1=Example project\nCDBASEVER=503\n",
    keys: ["SOFISTIK_C", "GRAFSIZE", "HEAD1", "CDBASEVER"],
    values: ["49", "SIZE -HP 0", "Example project", "503"],
    sections: [],
  },
  {
    name: "sections and mapping punctuation",
    source:
      "# Project settings\n[SOFiSTiK]\nSOFISTIK_A=0,1\n\n[STANDARDS]\nDIN_EN199X-200X@@0=EU\n[MAPPING]\nDIN_EN1992-2004=DIN_EN199X-200X@@0,@702   # case mapping\n",
    keys: ["SOFISTIK_A", "DIN_EN199X-200X@@0", "DIN_EN1992-2004"],
    values: ["0,1", "EU", "DIN_EN199X-200X@@0,@702   # case mapping"],
    sections: ["SOFiSTiK", "STANDARDS", "MAPPING"],
    comments: ["# Project settings"],
  },
  {
    name: "opaque values with literal hashes, quotes, semicolons and equals",
    source:
      "PATH=C:\\Shared Data\\models;D:\\Models\nHASH=alpha#beta\nQUOTED=\"alpha # beta\"\nSINGLE='quoted value'\nEXPR=first=second\nLITERAL=$HOME %PATH% $(NAME)\n",
    keys: ["PATH", "HASH", "QUOTED", "SINGLE", "EXPR", "LITERAL"],
    values: [
      "C:\\Shared Data\\models;D:\\Models",
      "alpha#beta",
      '"alpha # beta"',
      "'quoted value'",
      "first=second",
      "$HOME %PATH% $(NAME)",
    ],
    sections: [],
  },
  {
    name: "significant key and value whitespace",
    source: "  SOFISTIK_C = 49 \nCUSTOM KEY=value\n\tNEXT=\ttext\n",
    keys: ["SOFISTIK_C ", "CUSTOM KEY", "NEXT"],
    values: [" 49 ", "value", "\ttext"],
    sections: [],
  },
  {
    name: "empty values, CRLF, Unicode and missing final newline",
    source: "\uFEFF[sofistik]\r\nEMPTY=\r\nHEAD1=Most Łódź\r\nFINAL=",
    keys: ["EMPTY", "HEAD1", "FINAL"],
    values: ["Most Łódź"],
    sections: ["sofistik"],
  },
  {
    name: "hash-prefixed assignments are literal keys",
    source: "# Description without an equals sign\n#KEY=value\n;KEY=value\nKEY#PART=other",
    keys: ["#KEY", ";KEY", "KEY#PART"],
    values: ["value", "value", "other"],
    sections: [],
    comments: ["# Description without an equals sign"],
  },
  {
    name: "non-assignments are ignored without swallowing the next line",
    source: "# Description\nKEY:value\nKEY\nNEXT=1\n[EMPTY]",
    keys: ["NEXT"],
    values: ["1"],
    sections: ["EMPTY"],
    comments: ["# Description", "KEY:value", "KEY"],
  },
];

function texts(tree, type) {
  return tree.rootNode.descendantsOfType(type).map((node) => node.text);
}

function assertCase(tree, fixture) {
  assert.equal(tree.rootNode.hasError, false, tree.rootNode.toString());
  assert.deepEqual(texts(tree, "key"), fixture.keys);
  assert.deepEqual(texts(tree, "value"), fixture.values);
  assert.deepEqual(texts(tree, "section_name"), fixture.sections);
  assert.deepEqual(texts(tree, "comment"), fixture.comments || []);
  for (const node of tree.rootNode.descendantsOfType("assignment")) {
    assert.ok(node.childForFieldName("key"));
  }
  for (const node of tree.rootNode.descendantsOfType("section")) {
    assert.ok(node.childForFieldName("header").childForFieldName("name"));
  }
}

module.exports = { cases, texts, assertCase };
