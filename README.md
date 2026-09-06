# tree-sitter-sofistik

Parses SOFiSTiK CADINP input with Tree-sitter.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Grammar**: provides a Tree-sitter grammar for CADINP input.
- **Context**: restricts commands and items to the program that owns them.
- **Scope directives**: treats `$PROG` as a module context marker for include fragments rather than an executable program.
- **Transparent preprocessing**: preserves the active module across definition and conditional markers.
- **Structure**: exposes programs, commands, records, control flow, CDB statements, TEXT, and PICT blocks.
- **Tolerant diagnostics**: represents incomplete strings and orphan terminators with named nodes instead of parser recovery.
- **Program recovery**: ends an unterminated input block at the next root directive so later modules keep their own scope.
- **Values**: preserves numbers, strings, formatted values, positional references, and recursively nested variables.
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
npm run build:wasm
npm run test:wasm
npm test
npm run test:fuzz
```

`npm run build` compiles the checked-in C sources and does not require development dependencies or regenerate parser files. Regenerate the C parser, node types, scanner tables, and data provenance explicitly after advancing the pinned data package or changing the grammar:

```sh
npm run generate
npm run check:generated
```

The compact `src/schema.h` scanner tables derive commands and items from `getGrammarVocabulary()` and retain only enum values that collide with command names for resolver disambiguation. `schema/provenance.json` records the exact data commit together with the complete schema and grammar-vocabulary digests; the full versioned schema remains owned by `@lumine-code/sofistik-data` and is not copied into this repository.

An installed SOFiSTiK example tree can be checked without vendoring it by running `npm run test:corpus -- <directory>` or setting `SOFISTIK_CORPUS`. Add repeatable `--fallback-encoding <encoding>` options for legacy files and `--structure` when refreshing the recorded structural coverage snapshot.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
