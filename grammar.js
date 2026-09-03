const DOLLAR_VARIABLE_PATTERN = /\$\([^\r\n)]+\)/;

module.exports = grammar({
  name: "sofistik",

  externals: ($) => [
    $.module_name,
    $.invalid_module,
    $.command_name,
    $.invalid_command,
    $.item_name,
    $.invalid_item,
    $._bare_word,
    $.dynamic_command_name,
    $._template_command_name,
    $._end_keyword,
    $.variable_keyword,
    $._dollar_prog,
    $._dollar_apply,
    $._sequence_generator_start,
    $._parenthesized_expression_start,
    $.preprocessor_literal,
    $.continuation,
    $.comment,
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
    $._error_sentinel,
  ],

  extras: ($) => [/[ \t\f\uFEFF]+/, /\u00ef\u00bb\u00bf/, $.comment],

  supertypes: ($) => [$._value],

  conflicts: ($) => [
    [$.item_sequence, $.table_definition],
    [$._continued_input_block, $._module_tail_statement],
    [$._module_tail_statement],
  ],

  rules: {
    source_file: ($) =>
      repeat(
        choice(
          $.program,
          $.commented_program_scope,
          $.apply_statement,
          $.sys_statement,
          $._module_tail_statement,
        ),
      ),

    program: ($) =>
      prec.right(
        seq(
          field("header", $.program_header),
          field("body", $.input_block),
          repeat(
            seq(repeat($._line_end), field("body", alias($._continued_input_block, $.input_block))),
          ),
          repeat(field("tail", $._module_tail_statement)),
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
      prec.right(
        seq(
          field("header", $.commented_program_header),
          repeat(field("tail", $._module_tail_statement)),
        ),
      ),

    commented_program_sigil: ($) => $._dollar_prog,

    program_option: ($) => $._value,

    input_block: ($) => seq(repeat($._program_body), $.end_record),

    _continued_input_block: ($) =>
      prec.dynamic(
        1,
        choice($.end_record, seq($._program_body_start, repeat($._program_body), $.end_record)),
      ),

    _program_body: ($) => choice($._nonblank_program_body, $._line_end),

    _nonblank_program_body: ($) => choice($._program_body_start, $.implicit_record),

    _program_body_start: ($) =>
      choice(
        $.command,
        $.invalid_command_record,
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
        $.variable_statement,
        alias($._template_record, $.dynamic_record),
        $.text_block,
        $.metadata,
      ),

    command: ($) =>
      prec.right(
        seq(
          field("name", $.command_name),
          choice(
            seq(field("record", $.table_definition), repeat(field("record", $.table_row))),
            seq(
              field("record", $.record),
              repeat(
                choice(
                  field("record", $.implicit_record),
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
              ),
            ),
          ),
        ),
      ),

    invalid_command_record: ($) =>
      seq(field("name", $.invalid_command), repeat($._value), $._record_end),

    variable_statement: ($) =>
      seq(
        field("keyword", $.variable_keyword),
        field("variable", $.hash_variable),
        repeat(field("value", $._value)),
        $._statement_end,
      ),

    record: ($) => seq(repeat($._record_element), $._record_end),

    implicit_record: ($) => seq($._implicit_start, repeat($._record_element), $._record_end),

    _module_tail_expansion: ($) => seq($.dollar_variable, repeat($._record_element), $._record_end),

    _implicit_start: ($) => choice($.item_sequence, $.invalid_item, $._value),

    _record_element: ($) => choice($.item_sequence, $.invalid_item, $._value, $._continued_line),

    item_sequence: ($) =>
      prec.right(seq(field("item", $.item_name), repeat(field("value", $._value)))),

    table_definition: ($) =>
      prec.dynamic(2, seq(repeat1(field("item", $.item_name)), $._record_end)),

    table_row: ($) => seq(repeat1(field("value", $._value)), $._record_end),

    _continued_line: ($) => seq($.continuation, $._line_end),

    apply_statement: ($) =>
      prec.right(
        seq(field("sigil", $.apply_sigil), repeat(field("argument", $._value)), $._statement_end),
      ),

    apply_sigil: ($) =>
      choice($._dollar_apply, ci("APPLY"), token(prec(10, /[+-][aA][pP][pP][lL][yY]/))),

    sys_statement: ($) =>
      prec.right(
        seq(field("sigil", $.sys_sigil), repeat(field("argument", $._value)), $._statement_end),
      ),

    sys_sigil: ($) => choice(ci("SYS"), token(prec(10, /[+-][sS][yY][sS]/))),

    end_record: ($) =>
      prec.right(
        seq(field("keyword", alias($._end_keyword, $.control_keyword)), optional($._record_end)),
      ),

    loop_block: ($) => seq($.loop_header, repeat($._control_body), $.endloop_record),

    _control_body: ($) => choice($._program_body, $.end_record),

    loop_header: ($) =>
      seq(
        field("keyword", alias(ci("LOOP"), $.control_keyword)),
        repeat(field("argument", $._value)),
        $._record_end,
      ),

    endloop_record: ($) =>
      seq(
        field("keyword", alias(ci("ENDLOOP"), $.control_keyword)),
        repeat(field("condition", $._value)),
        $._record_end,
      ),

    if_block: ($) =>
      seq(
        $.if_header,
        repeat($._control_body),
        repeat(seq($.elseif_header, repeat($._control_body))),
        optional(seq($.else_header, repeat($._control_body))),
        $.endif_record,
      ),

    if_header: ($) =>
      seq(
        field("keyword", alias(ci("IF"), $.control_keyword)),
        repeat(field("condition", $._value)),
        $._record_end,
      ),

    elseif_header: ($) =>
      seq(
        field("keyword", alias(ci("ELSEIF"), $.control_keyword)),
        repeat(field("condition", $._value)),
        $._record_end,
      ),

    else_header: ($) => seq(field("keyword", alias(ci("ELSE"), $.control_keyword)), $._record_end),

    endif_record: ($) =>
      seq(field("keyword", alias(ci("ENDIF"), $.control_keyword)), $._record_end),

    exit_iteration_record: ($) =>
      seq(field("keyword", alias(ci("EXIT_ITERATION"), $.control_keyword)), $._record_end),

    preprocessor_define_statement: ($) =>
      prec.right(
        5,
        seq(
          field("keyword", alias(ci("#DEFINE"), $.preprocessor_keyword)),
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
        $._program_body_start,
        alias($._module_tail_expansion, $.implicit_record),
        $.end_record,
        $.ignored_text,
        $._line_end,
      ),

    preprocessor_define_header: ($) =>
      seq(
        field("keyword", alias(ci("#DEFINE"), $.preprocessor_keyword)),
        field("name", $.preprocessor_name),
        repeat(field("value", $._value)),
        $._record_end,
      ),

    preprocessor_enddef_record: ($) =>
      prec.right(
        seq(
          field("keyword", alias(ci("#ENDDEF"), $.preprocessor_keyword)),
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
            repeat(field("argument", $._value)),
            $._statement_end,
          ),
          seq(
            field("keyword", alias(ci("#UNDEF"), $.preprocessor_keyword)),
            repeat(field("argument", $.preprocessor_name)),
            $._statement_end,
          ),
        ),
      ),

    preprocessor_name: ($) => /#?[A-Za-z0-9_][A-Za-z0-9_-]*/,

    _template_record: ($) =>
      seq(
        field("name", alias($._template_command_name, $.dynamic_command_name)),
        repeat(field("value", choice($._value, $.continuation))),
        $._record_end,
      ),

    text_block: ($) =>
      prec.right(
        seq(
          field("start", $.text_start),
          optional($._line_end),
          repeat(
            field(
              "body",
              choice($.text_content, $.text_fragment, $.dollar_variable, $.hash_variable, $.string),
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
          field("argument", choice($.text_option, $.dollar_variable, $.hash_variable, $.string)),
        ),
        field("close", alias($._text_start_close, $.text_delimiter)),
      ),

    text_option: ($) => token(prec(1, /[^ \t\r\n>#$'"]+/)),

    metadata: ($) => token(seq("@", /[^\r\n]*/)),

    _value: ($) => choice($._non_bare_value, $.bare_value),

    _non_bare_value: ($) =>
      choice(
        $.string,
        $.sequence_generator,
        $.parenthesized_expression,
        $.number_list,
        $.number,
        $.dollar_variable,
        $.hash_variable,
        $.at_reference,
        $.expression,
        $.operator_expression,
        $.generic_expression,
        $.punctuated_value,
        $.unit,
      ),

    sequence_generator: ($) =>
      prec(
        5,
        seq(
          $._sequence_generator_start,
          field("part", $._generator_part),
          repeat1(field("part", $._generator_part)),
          token(prec(10, ")")),
        ),
      ),

    _generator_part: ($) =>
      choice($.generator_literal, $.hash_variable, $.dollar_variable, $.string),

    generator_literal: ($) => token(prec(5, /[^ \t\r\n()!#$;'"]+/)),

    parenthesized_expression: ($) =>
      prec(
        5,
        seq(
          $._parenthesized_expression_start,
          repeat(
            choice(
              $.parenthesized_expression,
              $.parenthesized_literal,
              $.hash_variable,
              $.dollar_variable,
              $.string,
              token(prec(1, /[^()!#$'"\r\n]+/)),
            ),
          ),
          token(prec(10, ")")),
        ),
      ),

    parenthesized_literal: ($) => token(prec(2, /\([^()!#$'"\r\n]*\)/)),

    string: ($) =>
      choice(
        interpolatedString($, "'", $._single_string_content),
        interpolatedString($, '"', $._double_string_content),
      ),

    number_list: ($) =>
      token(
        prec(
          2,
          /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:,[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)+/,
        ),
      ),

    number: ($) => /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,

    dollar_variable: ($) => DOLLAR_VARIABLE_PATTERN,

    hash_variable: ($) => /#(?:[A-Za-z_][A-Za-z0-9_]*|\d+)(?:\([^\r\n)]*\))?/,

    at_reference: ($) => /@[A-Za-z_][A-Za-z0-9_]*/,

    expression: ($) => token(prec(6, seq("=", optional(/[^\s;!'"#$]+/)))),

    operator_expression: ($) =>
      token(
        prec(
          4,
          new RegExp("[^ \\t\\r\\n;!$'\"#\\[\\]]+[*+\\u002d/^&|][^ \\t\\r\\n;!$'\"#\\[\\]]+"),
        ),
      ),

    generic_expression: ($) =>
      token(prec(2, /[^ \t\r\n;!$#'"\x5b\x5d]*#?[()<>](?:[^ \t\r\n;!$#'"\x5b\x5d]|#\()*/)),

    punctuated_value: ($) => token(prec(2, /[:~\\][A-Za-z_][A-Za-z0-9_]*/)),

    unit: ($) => /\[[^\]\r\n]+\]/,

    bare_value: ($) => $._bare_word,

    _statement_end: ($) => choice($._record_end, $._end_of_file),

    _record_end: ($) => choice(";", $._line_end),

    _line_end: ($) => /\r?\n/,
  },
});

function interpolatedString($, quote, contentToken) {
  return seq(
    token(prec(10, quote)),
    repeat(
      choice(
        alias(token.immediate(prec(20, DOLLAR_VARIABLE_PATTERN)), $.dollar_variable),
        contentToken,
      ),
    ),
    token.immediate(prec(10, quote)),
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
