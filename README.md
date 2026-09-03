# tree-sitter-sofistik

Parses SOFiSTiK CADINP input with Tree-sitter.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Grammar**: provides a Tree-sitter grammar for CADINP input.
- **Context**: restricts commands and items to the program that owns them.
- **Scope directives**: treats `$PROG` as a module context marker for include fragments rather than an executable program.
- **Transparent preprocessing**: preserves the active module across definition and conditional markers.
- **Structure**: exposes programs, commands, records, control flow, and preprocessors.
- **Descriptive text**: accepts ignored prose between program scopes without weakening command validation inside them.
- **Neutral values**: leaves enum-like values and generator literals unclassified while retaining variable nodes.
- **Generated schema**: derives its accepted vocabulary from the pinned `@lumine-code/sofistik-data` package.
- **Bindings**: supports Node-API, source, and WebAssembly builds.

## Installation

```sh
npm install tree-sitter @lumine-code/tree-sitter-sofistik
```

## Usage

```js
const Parser = require("tree-sitter");
const SOFiSTiK = require("@lumine-code/tree-sitter-sofistik");

const parser = new Parser();
parser.setLanguage(SOFiSTiK);
const tree = parser.parse("+PROG AQUA\nHEAD Example\nEND\n");
```

## Building

```sh
npm install
npm test
npm run build:wasm
```

`npm run build` compiles the checked-in C sources and does not require development dependencies or regenerate parser files. Regenerate the C parser, node types, scanner tables, and data provenance explicitly after advancing the pinned data package or changing the grammar:

```sh
npm run generate
npm run check:generated
```

The compact `src/schema.h` scanner tables come directly from `getGrammarVocabulary()`. `schema/provenance.json` records the exact data commit together with the complete schema and grammar-vocabulary digests; the full versioned schema remains owned by `@lumine-code/sofistik-data` and is not copied into this repository.

An installed SOFiSTiK example tree can be checked without vendoring it by running `npm run test:corpus -- <directory>` or setting `SOFISTIK_CORPUS`.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
