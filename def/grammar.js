/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

module.exports = grammar({
  name: "sofistik_def",

  extras: () => [/[ \t\f\uFEFF]/],

  rules: {
    source_file: ($) =>
      seq(
        repeat($._line),
        repeat($.section),
        optional(choice($.assignment, $.comment, alias($._final_section, $.section))),
      ),

    _line: ($) => choice($._newline, seq(choice($.assignment, $.comment), $._newline)),
    _newline: () => /\r?\n/,

    section: ($) =>
      prec.right(
        seq(
          field("header", $.section_header),
          $._newline,
          repeat($._line),
          optional(choice($.assignment, $.comment)),
        ),
      ),

    _final_section: ($) => field("header", $.section_header),
    section_header: ($) => seq("[", field("name", $.section_name), "]"),
    section_name: () => /[^\x5b\]\r\n]+/,

    assignment: ($) =>
      seq(field("key", alias($._entry_text, $.key)), "=", optional(field("value", $.value))),
    _entry_text: () => /[^=\x5b\r\n \t\f\uFEFF][^=\r\n]*/,
    value: () => token(prec(1, /[^\r\n]+/)),

    // The reader ignores lines without '='. '#' is the vendor's convention
    // for descriptions; when '=' is present, even '#KEY' is a literal key.
    comment: ($) => $._entry_text,
  },
});
