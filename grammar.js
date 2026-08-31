module.exports = grammar({
  name: "sofistik",

  externals: ($) => [
    $.module_name,
    $.invalid_module,
    $.command_name,
    $.invalid_command,
    $.item_name,
    $.invalid_item,
    $.enum_value,
    $._bare_word,
    $.dynamic_command_name,
    $._template_command_name,
    $._end_keyword,
    $.variable_keyword,
    $._dollar_prog,
    $._dollar_apply,
    $.continuation,
    $.comment,
    $.text_content,
    $._error_sentinel,
  ],

  extras: ($) => [/[ \t\f\uFEFF]+/, $.comment],

  supertypes: ($) => [$._value],

  conflicts: ($) => [[$.item_sequence, $.table_definition], [$.program]],

  rules: {
    source_file: ($) =>
      repeat(
        choice(
          $.program,
          $.apply_statement,
          $.sys_statement,
          $.preprocessor_block,
          $.preprocessor_define_statement,
          $.preprocessor_directive,
          $.text_block,
          $.metadata,
          $._line_end,
        ),
      ),

    program: ($) =>
      seq(
        field("header", $.program_header),
        field("body", $.input_block),
        repeat(
          seq(repeat($._line_end), field("body", alias($._continued_input_block, $.input_block))),
        ),
      ),

    program_header: ($) =>
      seq(
        field("sigil", $.program_sigil),
        field("module", choice($.module_name, $.invalid_module)),
        repeat(field("option", $.program_option)),
        $._record_end,
      ),

    program_sigil: ($) =>
      choice($._dollar_prog, ci("PROG"), token(prec(10, /[+-][pP][rR][oO][gG]/))),

    program_option: ($) => $._value,

    input_block: ($) => seq(repeat($._program_body), $.end_record),

    _continued_input_block: ($) =>
      choice($.end_record, seq($._nonblank_program_body, repeat($._program_body), $.end_record)),

    _program_body: ($) => choice($._nonblank_program_body, $._line_end),

    _nonblank_program_body: ($) =>
      choice(
        $.command,
        $.invalid_command_record,
        $.loop_block,
        $.if_block,
        $.exit_iteration_record,
        $.preprocessor_program_block,
        $.preprocessor_define_block,
        $.preprocessor_define_statement,
        $.preprocessor_directive,
        $.variable_statement,
        $.implicit_record,
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
                  field("auxiliary", $.variable_statement),
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
        $._record_end,
      ),

    record: ($) => seq(repeat($._record_element), $._record_end),

    implicit_record: ($) => seq($._implicit_start, repeat($._record_element), $._record_end),

    _implicit_start: ($) => choice($.item_sequence, $.invalid_item, $._value),

    _record_element: ($) => choice($.item_sequence, $.invalid_item, $._value, $._continued_line),

    item_sequence: ($) =>
      prec.right(
        seq(
          field("item", $.item_name),
          choice(
            seq(field("value", $.enum_value), repeat(field("value", $._value))),
            repeat(field("value", $._value)),
          ),
        ),
      ),

    table_definition: ($) =>
      prec.dynamic(2, seq(repeat1(field("item", $.item_name)), $._record_end)),

    table_row: ($) => seq(repeat1(field("value", $._value)), $._record_end),

    _continued_line: ($) => seq($.continuation, $._line_end),

    apply_statement: ($) =>
      prec.right(
        seq(
          field("sigil", $.apply_sigil),
          repeat(field("argument", $._value)),
          optional($._record_end),
        ),
      ),

    apply_sigil: ($) =>
      choice($._dollar_apply, ci("APPLY"), token(prec(10, /[+-][aA][pP][pP][lL][yY]/))),

    sys_statement: ($) =>
      prec.right(
        seq(
          field("sigil", $.sys_sigil),
          repeat(field("argument", $._value)),
          optional($._record_end),
        ),
      ),

    sys_sigil: ($) => choice(ci("SYS"), token(prec(10, /[+-][sS][yY][sS]/))),

    end_record: ($) => prec.right(seq(field("keyword", $._end_keyword), optional($._record_end))),

    loop_block: ($) => seq($.loop_header, repeat($._program_body), $.endloop_record),

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
        repeat($._program_body),
        repeat(seq($.elseif_header, repeat($._program_body))),
        optional(seq($.else_header, repeat($._program_body))),
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

    preprocessor_block: ($) => choice($.preprocessor_define_block, $._preprocessor_top_level),

    preprocessor_define_block: ($) =>
      seq(
        $.preprocessor_define_header,
        repeat(choice($.dynamic_record, $.dynamic_line, $.text_block, $._line_end)),
        $.preprocessor_enddef_record,
      ),

    preprocessor_define_statement: ($) =>
      prec.right(
        5,
        seq(
          field("keyword", alias(ci("#DEFINE"), $.preprocessor_keyword)),
          field("name", $.preprocessor_name),
          field("value", $.expression),
          repeat(field("value", $._value)),
          optional($._record_end),
        ),
      ),

    preprocessor_program_block: ($) =>
      seq(
        $.preprocessor_if_header,
        repeat($._program_body),
        repeat(seq($.preprocessor_elseif_header, repeat($._program_body))),
        optional(seq($.preprocessor_else_header, repeat($._program_body))),
        $.preprocessor_endif_record,
      ),

    _preprocessor_top_level: ($) =>
      seq(
        $.preprocessor_if_header,
        repeat($._top_level_preprocessor_body),
        repeat(seq($.preprocessor_elseif_header, repeat($._top_level_preprocessor_body))),
        optional(seq($.preprocessor_else_header, repeat($._top_level_preprocessor_body))),
        $.preprocessor_endif_record,
      ),

    _top_level_preprocessor_body: ($) =>
      choice(
        $.program,
        $.apply_statement,
        $.sys_statement,
        $.preprocessor_block,
        $.preprocessor_define_statement,
        $.preprocessor_directive,
        $.text_block,
        $.metadata,
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
        repeat(field("condition", $._value)),
        $._record_end,
      ),

    preprocessor_elseif_header: ($) =>
      seq(
        field("keyword", alias(ci("#ELSEIF"), $.preprocessor_keyword)),
        repeat(field("condition", $._value)),
        $._record_end,
      ),

    preprocessor_else_header: ($) =>
      seq(field("keyword", alias(ci("#ELSE"), $.preprocessor_keyword)), $._record_end),

    preprocessor_endif_record: ($) =>
      prec.right(
        seq(field("keyword", alias(ci("#ENDIF"), $.preprocessor_keyword)), optional($._record_end)),
      ),

    preprocessor_directive: ($) =>
      prec.right(
        seq(
          field("keyword", alias(choice(ci("#INCLUDE"), ci("#UNDEF")), $.preprocessor_keyword)),
          repeat(field("argument", $._value)),
          optional($._record_end),
        ),
      ),

    preprocessor_name: ($) => /[A-Za-z0-9_]+/,

    dynamic_record: ($) =>
      seq(
        field("name", $.dynamic_command_name),
        repeat(field("value", choice($._value, $.continuation))),
        $._record_end,
      ),

    dynamic_line: ($) => seq(repeat1(field("value", $._value)), $._record_end),

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
          optional(field("body", $.text_content)),
          field("end", $.text_end),
          optional($._line_end),
        ),
      ),

    text_start: ($) => token(prec(10, /<[tT][eE][xX][tT](?:,[^>\r\n]*)?>/)),

    text_end: ($) => token(prec(10, /<\/[tT][eE][xX][tT]>/)),

    metadata: ($) => token(seq("@", /[^\r\n]*/)),

    _value: ($) => choice($._non_bare_value, $.bare_value),

    _non_bare_value: ($) =>
      choice(
        $.string,
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

    string: ($) =>
      choice(
        token(seq("'", repeat(choice(/[^'\r\n]+/, "''")), "'")),
        token(seq('"', repeat(choice(/[^"\r\n]+/, '""')), '"')),
      ),

    number_list: ($) =>
      token(
        prec(
          2,
          /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:,[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)+/,
        ),
      ),

    number: ($) => /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/,

    dollar_variable: ($) => /\$\([^\r\n)]+\)/,

    hash_variable: ($) => /#(?:[A-Za-z_][A-Za-z0-9_]*|\d+)(?:\([^\r\n)]*\))?/,

    at_reference: ($) => /@[A-Za-z_][A-Za-z0-9_]*/,

    expression: ($) => token(prec(6, seq("=", optional(/[^\s;!]+/)))),

    operator_expression: ($) => token(prec(4, /[^ \t\r\n;!$'"]+[*+\u002d/^&|][^ \t\r\n;!$'"]+/)),

    generic_expression: ($) => token(prec(2, /[^ \t\r\n;!$'"]*[()<>][^ \t\r\n;!$'"]*/)),

    punctuated_value: ($) => token(prec(2, /[:~\\][A-Za-z_][A-Za-z0-9_]*/)),

    unit: ($) => /\[[^\]\r\n]+\]/,

    bare_value: ($) => $._bare_word,

    _record_end: ($) => choice(";", $._line_end),

    _line_end: ($) => /\r?\n/,
  },
});

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
