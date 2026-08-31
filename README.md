# tree-sitter-sofistik

Parses SOFiSTiK CADINP input with Tree-sitter.

> **NOTE**: This package is not an official SOFiSTiK product and is not affiliated with or endorsed by SOFiSTiK AG.

## Features

- **Grammar**: provides a Tree-sitter grammar for CADINP input.
- **Context**: restricts commands and items to the program that owns them.
- **Structure**: exposes programs, commands, records, control flow, and preprocessors.
- **Generated schema**: derives its accepted vocabulary from the language data snapshot.
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

Import a fresh schema snapshot before regenerating the parser:

```sh
npm run import:schema -- ../language-sofistik/schema
npm run generate
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
