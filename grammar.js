const DOLLAR_VARIABLE_PATTERN = /\$\([^\r\n)]+\)/;

module.exports = grammar({
  name: "sofistik",

  externals: ($) => [
    $.module_name,
    $.invalid_module,
    $.command_name,
    $.invalid_command,
    $.item_name,
    $.hash_variable_name,
    $.literal_hash,
    $._bare_word,
    $._value_separator,
    $._end_keyword,
    $.variable_keyword,
    $._dollar_prog,
    $._dollar_apply,
    $._apply_sigil,
    $._sys_sigil,
    $._sequence_generator_start,
    $._generator_separator,
    $.literal_opening_parenthesis,
    $.preprocessor_literal,
    $.continuation,
    $.comment,
    $.unterminated_single_quoted_string,
    $.unterminated_double_quoted_string,
    $._single_string_content,
    $._double_string_content,
    $._text_start_open,
    $._text_start_close,
    $.text_end,
    $.text_fragment,
    $.text_content,
    $._end_of_file,
    $.ignored_text,
    $._preprocessor_recovery_value,
    $.unterminated_input_block,
    $._define_keyword,
    $._enddef_keyword,
    $._table_start,
    $._command_end,
    $._mojibake_bom,
    $._error_sentinel,
  ],

  extras: ($) => [/[ \t\f\uFEFF]+/, $._mojibake_bom, $.comment],

  supertypes: ($) => [$._value],

  rules: {
    source_file: ($) =>
      repeat(
        choice(
          $.program,
          $.commented_program_scope,
          $.apply_statement,
          $.sys_statement,
          $.unscoped_record,
          $._module_tail_statement,
        ),
      ),

    unscoped_record: ($) =>
      seq(field("value", $.bare_value), repeat(field("value", $._record_element)), $._record_end),

    program: ($) =>
      prec.right(
        seq(
          field("header", $.program_header),
          field("body", $.input_block),
          repeat($._module_tail_group),
        ),
      ),

    program_header: ($) =>
      seq(
        field("sigil", $.program_sigil),
        field("module", choice($.module_name, $.invalid_module)),
        repeat(field("option", $.program_option)),
        $._record_end,
      ),

    program_sigil: ($) => choice(ci("PROG"), token(prec(10, /[+-][pP][rR][oO][gG]/))),

    commented_program_header: ($) =>
      seq(
        field("sigil", $.commented_program_sigil),
        optional(field("module", choice($.module_name, $.invalid_module))),
        repeat(field("option", $.program_option)),
        $._record_end,
      ),

    commented_program_scope: ($) =>
      prec.right(seq(field("header", $.commented_program_header), repeat($._module_tail_group))),

    _module_tail_group: ($) => boundedChunk($._module_tail_chunk),

    _module_tail_chunk: ($) => boundedChunk($._module_tail_element),

    _module_tail_element: ($) => field("tail", $._module_tail_statement),

    commented_program_sigil: ($) => $._dollar_prog,

    program_option: ($) => $._value,

    input_block: ($) =>
      seq(repeat($._program_body_group), choice($.end_record, $.unterminated_input_block)),

    // Hidden groups keep the public tree flat while giving incremental parses
    // reusable boundaries inside large programs. Tree-sitter's repetition
    // nodes are fragile, so a single repeat otherwise replays every command.
    _program_body_group: ($) => boundedChunk($._program_body_chunk),

    _program_body_chunk: ($) => boundedChunk($._program_body),

    _program_body: ($) => choice($._nonblank_program_body, $._line_end),

    _nonblank_program_body: ($) => choice($._program_body_start, $.implicit_record),

    _program_body_start: ($) =>
      choice(
        $._structured_program_body_start,
        $.invalid_command_record,
        $.orphan_elseif_record,
        $.orphan_else_record,
        $.orphan_endif_record,
        $.orphan_endloop_record,
        $.orphan_text_end,
        $.orphan_picture_end,
      ),

    _structured_program_body_start: ($) =>
      choice(
        $.command,
        $.loop_block,
        $.if_block,
        $.exit_iteration_record,
        $.preprocessor_if_header,
        $.preprocessor_elseif_header,
        $.preprocessor_else_header,
        $.preprocessor_endif_record,
        $.preprocessor_define_header,
        $.preprocessor_enddef_record,
        $.preprocessor_define_statement,
        $.preprocessor_directive,
        $.cdb_statement,
        $.variable_statement,
        $.text_block,
        $.picture_block,
        $.metadata,
      ),

    command: ($) =>
      prec.right(
        seq(
          field("name", $.command_name),
          choice(
            seq(field("record", $.table_definition), repeat($._table_body_group)),
            seq(field("record", $.record), repeat($._command_body_group)),
          ),
          // Commit the command before lexing its successor in the outer scope.
          // This keeps reused tail groups in the same external lexer context.
          $._command_end,
        ),
      ),

    _table_body_group: ($) => boundedChunk($._table_body_chunk),

    _table_body_chunk: ($) => boundedChunk($._table_body),

    _table_body: ($) => choice(field("record", $.table_row), $._line_end),

    _command_body_group: ($) => boundedChunk($._command_body_chunk),

    _command_body_chunk: ($) => boundedChunk($._command_body),

    _command_body: ($) =>
      choice(
        field("record", $.implicit_record),
        $._line_end,
        field(
          "auxiliary",
          choice(
            $.variable_statement,
            $.preprocessor_directive,
            $.preprocessor_define_header,
            $.preprocessor_define_statement,
          ),
        ),
      ),

    invalid_command_record: ($) =>
      seq(field("name", $.invalid_command), repeat($._separated_value), $._record_end),

    variable_statement: ($) =>
      seq(
        field("keyword", $.variable_keyword),
        field("variable", $.hash_variable),
        repeat(field("value", $._separated_value)),
        $._statement_end,
      ),

    record: ($) => seq(repeat($._record_element), $._record_end),

    implicit_record: ($) => seq($._implicit_start, repeat($._record_element), $._record_end),

    _module_tail_expansion: ($) => seq($.dollar_variable, repeat($._record_element), $._record_end),

    _implicit_start: ($) => choice($.item_sequence, $._value),

    _record_element: ($) =>
      choice($.item_sequence, $._value, $._value_separator, $._continued_line),

    item_sequence: ($) =>
      prec.right(seq(field("item", $.item_name), repeat(field("value", $._separated_value)))),

    // The scanner recognizes an all-item header once, so subsequent rows do
    // not keep an alternative implicit-record parse alive for the whole table.
    table_definition: ($) =>
      seq(
        field("item", alias($._table_start, $.item_name)),
        repeat(field("item", $.item_name)),
        $._record_end,
      ),

    table_row: ($) =>
      seq(
        field("value", $._value),
        repeat(choice($._value_separator, field("value", $._value))),
        $._record_end,
      ),

    _continued_line: ($) => seq($.continuation, $._line_end),

    apply_statement: ($) =>
      prec.right(
        seq(
          field("sigil", $.apply_sigil),
          repeat(field("argument", $._separated_value)),
          $._statement_end,
        ),
      ),

    apply_sigil: ($) => choice($._dollar_apply, $._apply_sigil),

    sys_statement: ($) =>
      prec.right(
        seq(
          field("sigil", $.sys_sigil),
          repeat(field("argument", $._separated_value)),
          $._statement_end,
        ),
      ),

    sys_sigil: ($) => $._sys_sigil,

    end_record: ($) =>
      prec.right(seq(field("keyword", alias($._end_keyword, $.control_keyword)), $._record_end)),

    loop_block: ($) =>
      prec.right(seq($.loop_header, repeat($._control_body_group), $.endloop_record)),

    _control_body_group: ($) => boundedChunk($._control_body_chunk),

    _control_body_chunk: ($) => boundedChunk($._control_body),

    _control_body: ($) =>
      choice(
        $._structured_program_body_start,
        $.invalid_command_record,
        $.orphan_text_end,
        $.orphan_picture_end,
        $.implicit_record,
        $._line_end,
        $.end_record,
      ),

    loop_header: ($) =>
      prec.dynamic(
        10,
        seq(
          field("keyword", alias(ci("LOOP"), $.control_keyword)),
          repeat(field("argument", $._value)),
          $._record_end,
        ),
      ),

    endloop_record: ($) =>
      prec.dynamic(
        10,
        seq(
          field("keyword", alias(ci("ENDLOOP"), $.control_keyword)),
          repeat(field("condition", $._value)),
          $._record_end,
        ),
      ),

    if_block: ($) =>
      prec.right(
        seq(
          $.if_header,
          repeat($._control_body_group),
          repeat(seq($.elseif_header, repeat($._control_body_group))),
          optional(seq($.else_header, repeat($._control_body_group))),
          $.endif_record,
        ),
      ),

    if_header: ($) =>
      prec.dynamic(
        10,
        seq(
          field("keyword", alias(ci("IF"), $.control_keyword)),
          repeat(field("condition", $._value)),
          $._record_end,
        ),
      ),

    elseif_header: ($) =>
      prec.dynamic(
        10,
        seq(
          field("keyword", alias(ci("ELSEIF"), $.control_keyword)),
          repeat(field("condition", $._value)),
          $._record_end,
        ),
      ),

    else_header: ($) =>
      prec.dynamic(
        10,
        seq(
          field("keyword", alias(ci("ELSE"), $.control_keyword)),
          repeat(field("condition", $._value)),
          $._record_end,
        ),
      ),

    endif_record: ($) =>
      prec.dynamic(10, seq(field("keyword", alias(ci("ENDIF"), $.control_keyword)), $._record_end)),

    exit_iteration_record: ($) =>
      seq(field("keyword", alias(ci("EXIT_ITERATION"), $.control_keyword)), $._record_end),

    preprocessor_define_statement: ($) =>
      prec.right(
        5,
        seq(
          field("keyword", alias($._define_keyword, $.preprocessor_keyword)),
          field("name", $.preprocessor_name),
          field("value", $.preprocessor_value),
          $._statement_end,
        ),
      ),

    preprocessor_value: ($) =>
      prec.right(
        10,
        choice(
          seq(
            token(prec(20, "=")),
            repeat1(choice($.dollar_variable, $.hash_variable, $.string, $.preprocessor_literal)),
          ),
          $._preprocessor_recovery_value,
        ),
      ),

    _module_tail_statement: ($) =>
      choice(
        $._structured_program_body_start,
        $.orphan_elseif_record,
        $.orphan_else_record,
        $.orphan_endif_record,
        $.orphan_endloop_record,
        $.orphan_text_end,
        $.orphan_picture_end,
        alias($._module_tail_expansion, $.implicit_record),
        $.end_record,
        $.ignored_text,
        $._line_end,
      ),

    preprocessor_define_header: ($) =>
      seq(
        field("keyword", alias($._define_keyword, $.preprocessor_keyword)),
        field("name", $.preprocessor_name),
        repeat(field("value", $._separated_value)),
        $._record_end,
      ),

    preprocessor_enddef_record: ($) =>
      prec.right(
        seq(
          field("keyword", alias($._enddef_keyword, $.preprocessor_keyword)),
          optional($._record_end),
        ),
      ),

    preprocessor_if_header: ($) =>
      seq(
        field("keyword", alias(ci("#IF"), $.preprocessor_keyword)),
        optional(field("condition", $.preprocessor_condition)),
        $._statement_end,
      ),

    preprocessor_elseif_header: ($) =>
      seq(
        field("keyword", alias(ci("#ELSEIF"), $.preprocessor_keyword)),
        optional(field("condition", $.preprocessor_condition)),
        $._statement_end,
      ),

    preprocessor_else_header: ($) =>
      seq(field("keyword", alias(ci("#ELSE"), $.preprocessor_keyword)), $._statement_end),

    preprocessor_endif_record: ($) =>
      seq(field("keyword", alias(ci("#ENDIF"), $.preprocessor_keyword)), $._statement_end),

    preprocessor_condition: ($) =>
      repeat1(choice($.dollar_variable, $.hash_variable, $.string, $.preprocessor_literal)),

    preprocessor_directive: ($) =>
      prec.right(
        choice(
          seq(
            field("keyword", alias(ci("#INCLUDE"), $.preprocessor_keyword)),
            repeat(field("argument", $._separated_value)),
            $._statement_end,
          ),
          seq(
            field("keyword", alias(ci("#UNDEF"), $.preprocessor_keyword)),
            repeat(field("argument", $.preprocessor_name)),
            $._statement_end,
          ),
        ),
      ),

    cdb_statement: ($) =>
      prec.right(
        seq(
          field("keyword", $.cdb_keyword),
          repeat(field("argument", $._separated_value)),
          $._statement_end,
        ),
      ),

    cdb_keyword: ($) => choice(ci("@KEY"), ci("@CDB")),

    preprocessor_name: ($) => /#?[A-Za-z0-9_][A-Za-z0-9_.-]*/,

    text_block: ($) =>
      prec.right(
        seq(
          field("start", $.text_start),
          optional($._line_end),
          repeat(
            field(
              "body",
              choice(
                $.text_content,
                $.text_fragment,
                $.dollar_variable,
                $.hash_variable,
                $.formatted_value,
                $.literal_hash,
                $.at_reference,
                $.string,
                $.unterminated_string,
              ),
            ),
          ),
          field("end", $.text_end),
          optional($._line_end),
        ),
      ),

    text_start: ($) =>
      seq(
        field("open", alias($._text_start_open, $.text_delimiter)),
        repeat(
          field(
            "argument",
            choice(
              $.text_option,
              $.dollar_variable,
              $.hash_variable,
              $.string,
              $.unterminated_string,
            ),
          ),
        ),
        field("close", alias($._text_start_close, $.text_delimiter)),
      ),

    text_option: ($) => token(prec(1, /[^ \t\r\n>#$'"]+/)),

    picture_block: ($) =>
      prec.right(
        seq(
          field("start", $.picture_start),
          repeat($._picture_body_group),
          field("end", $.picture_end),
        ),
      ),

    _picture_body_group: ($) => boundedChunk($._picture_body_chunk),

    _picture_body_chunk: ($) => boundedChunk($._picture_body),

    _picture_body: ($) =>
      choice(
        $._structured_program_body_start,
        $.invalid_command_record,
        $.orphan_elseif_record,
        $.orphan_else_record,
        $.orphan_endif_record,
        $.orphan_endloop_record,
        $.orphan_text_end,
        $.implicit_record,
        $._line_end,
      ),

    picture_start: ($) =>
      seq(
        field("delimiter", alias(ci("<PICT>"), $.picture_delimiter)),
        repeat(field("argument", $._separated_value)),
        $._record_end,
      ),

    picture_end: ($) =>
      seq(field("delimiter", alias(ci("</PICT>"), $.picture_delimiter)), $._statement_end),

    orphan_elseif_record: ($) => orphanControl($, "ELSEIF"),

    orphan_else_record: ($) => orphanControl($, "ELSE"),

    orphan_endif_record: ($) => orphanControl($, "ENDIF"),

    orphan_endloop_record: ($) => orphanControl($, "ENDLOOP"),

    orphan_text_end: ($) =>
      prec.dynamic(
        -10,
        seq(field("delimiter", alias(ci("</TEXT>"), $.text_delimiter)), $._statement_end),
      ),

    orphan_picture_end: ($) =>
      prec.dynamic(
        -10,
        seq(field("delimiter", alias(ci("</PICT>"), $.picture_delimiter)), $._statement_end),
      ),

    metadata: ($) => token(seq("@", /[ \t]+[^;\r\n]*/)),

    _value: ($) => choice($._non_bare_value, $.bare_value),

    _separated_value: ($) => choice($._value, $._value_separator),

    _non_bare_value: ($) =>
      choice(
        $.string,
        $.unterminated_string,
        $.sequence_generator,
        $.parenthesized_expression,
        $.number_list,
        $.number,
        $.dollar_variable,
        $.hash_variable,
        $.formatted_value,
        $.literal_hash,
        $.literal_opening_parenthesis,
        $.literal_closing_parenthesis,
        $.at_reference,
        $.invalid_at_reference,
        $.expression,
        $.operator_expression,
        $.generic_expression,
        $.punctuated_value,
        $.unit,
      ),

    sequence_generator: ($) =>
      prec.dynamic(
        1,
        seq(
          $._sequence_generator_start,
          optional($._generator_separator),
          field("part", $.generator_part),
          repeat1(seq($._generator_separator, field("part", $.generator_part))),
          optional($._generator_separator),
          ")",
        ),
      ),

    generator_part: ($) =>
      repeat1(choice($.generator_literal, $.hash_variable, $.dollar_variable, $.string)),

    generator_literal: ($) => token.immediate(prec(5, /[^ \t\r\n()!#$;'"]+/)),

    parenthesized_expression: ($) =>
      prec(
        5,
        seq(
          "(",
          repeat(
            choice(
              $.parenthesized_expression,
              $.hash_variable,
              $.formatted_value,
              $.dollar_variable,
              $.string,
              $.parenthesized_content,
            ),
          ),
          ")",
        ),
      ),

    parenthesized_content: ($) => token.immediate(prec(1, /[^()!#$'"\r\n]+/)),

    string: ($) =>
      choice(
        $.single_doubled_quoted_string,
        $.double_doubled_quoted_string,
        $.single_quoted_string,
        $.double_quoted_string,
      ),

    single_doubled_quoted_string: ($) => token(prec(20, /''[^'\r\n]*''/)),

    double_doubled_quoted_string: ($) => token(prec(20, /""[^"\r\n]*""/)),

    single_quoted_string: ($) => quotedString($, "'", $._single_string_content),

    double_quoted_string: ($) => quotedString($, '"', $._double_string_content),

    unterminated_string: ($) =>
      choice($.unterminated_single_quoted_string, $.unterminated_double_quoted_string),

    number_list: ($) =>
      token(
        prec(
          2,
          /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:,[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)+/,
        ),
      ),

    number: ($) => /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,

    dollar_variable: ($) => DOLLAR_VARIABLE_PATTERN,

    hash_variable: ($) =>
      seq(field("name", $.hash_variable_name), optional(field("arguments", $.hash_arguments))),

    hash_arguments: ($) =>
      seq(
        token.immediate("("),
        repeat(
          choice(
            $.parenthesized_expression,
            $.hash_variable,
            $.formatted_value,
            $.dollar_variable,
            $.string,
            $.hash_argument_content,
          ),
        ),
        ")",
      ),

    hash_argument_content: ($) => token.immediate(prec(1, /[^()!#$'"\r\n]+/)),

    formatted_value: ($) => seq(token(prec(5, "#")), field("value", $.parenthesized_expression)),

    literal_closing_parenthesis: ($) => ")",

    at_reference: ($) => token(prec(4, /@(?:[A-Za-z_][A-Za-z0-9_]*|[+-]?\d+|\([^;!\r\n)]*\))/)),

    invalid_at_reference: ($) => token(prec(-1, /@[^ \t\f;!\r\n,]+/)),

    expression: ($) => token(prec(6, "=")),

    operator_expression: ($) =>
      token(
        prec(
          4,
          new RegExp(
            "[^ \\t\\r\\n(),;!$'\"#@\\[\\]]+[*+\\u002d/^&|][^ \\t\\r\\n(),;!$'\"#@\\[\\]]+",
          ),
        ),
      ),

    generic_expression: ($) =>
      token(prec(2, /[^ \t\r\n;!$#@'"\x5b\x5d]*[<>][^ \t\r\n;!$#@'"\x5b\x5d]*/)),

    punctuated_value: ($) => token(prec(2, /[:~\\][A-Za-z_][A-Za-z0-9_]*/)),

    unit: ($) => /\[[^\]\r\n]+\]/,

    bare_value: ($) => $._bare_word,

    _statement_end: ($) => $._record_end,

    _record_end: ($) => choice(";", $._line_end, $._end_of_file),

    _line_end: ($) => /\r?\n/,
  },
});

function quotedString($, quote, contentToken) {
  // Substitutions can include escaped quotes, but cannot consume the string's
  // physical closing quote or look for ')' among the following arguments.
  const dollarPattern = new RegExp(`\\$\\((?:[^\\r\\n)${quote}]|${quote}${quote})+\\)`);
  return seq(
    token(prec(10, quote)),
    repeat(
      choice(alias(token.immediate(prec(20, dollarPattern)), $.dollar_variable), contentToken),
    ),
    token.immediate(prec(10, quote)),
  );
}

function boundedChunk(element, size = 8) {
  // Consume a complete group when possible, with a shorter final group.
  return prec.right(seq(element, ...Array.from({ length: size - 1 }, () => optional(element))));
}

function orphanControl($, keyword) {
  return prec.dynamic(
    -10,
    seq(
      field("keyword", alias(ci(keyword), $.control_keyword)),
      repeat(field("argument", $._value)),
      $._record_end,
    ),
  );
}

function ci(value) {
  const source = [...value]
    .map((character) => {
      if (/[A-Za-z]/.test(character)) {
        return `[${character.toLowerCase()}${character.toUpperCase()}]`;
      }
      return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    })
    .join("");
  return token(prec(5, new RegExp(source)));
}
