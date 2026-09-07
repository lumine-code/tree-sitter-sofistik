#include "tree_sitter/parser.h"

#include "schema.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum TokenType {
  MODULE_NAME,
  INVALID_MODULE,
  COMMAND_NAME,
  INVALID_COMMAND,
  ITEM_NAME,
  HASH_VARIABLE_NAME,
  LITERAL_HASH,
  BARE_WORD,
  VALUE_SEPARATOR,
  DYNAMIC_COMMAND_NAME,
  TEMPLATE_COMMAND_NAME,
  END_KEYWORD,
  VARIABLE_KEYWORD,
  DOLLAR_PROG,
  DOLLAR_APPLY,
  APPLY_SIGIL,
  SYS_SIGIL,
  SEQUENCE_GENERATOR_START,
  GENERATOR_SEPARATOR,
  LITERAL_OPENING_PARENTHESIS,
  PREPROCESSOR_LITERAL,
  CONTINUATION,
  COMMENT,
  UNTERMINATED_SINGLE_QUOTED_STRING,
  UNTERMINATED_DOUBLE_QUOTED_STRING,
  SINGLE_STRING_CONTENT,
  DOUBLE_STRING_CONTENT,
  TEXT_START_OPEN,
  TEXT_START_CLOSE,
  TEXT_END,
  TEXT_FRAGMENT,
  TEXT_CONTENT,
  END_OF_FILE,
  IGNORED_TEXT,
  PREPROCESSOR_RECOVERY_VALUE,
  UNTERMINATED_INPUT_BLOCK,
  ERROR_SENTINEL,
};

// TEXT bodies are segmented so variables and strings stay visible. Tracking
// the header/body boundary keeps those external tokens safe during recovery,
// when Tree-sitter reports every external symbol as valid.
enum TextState {
  OUTSIDE_TEXT,
  IN_TEXT_HEADER,
  IN_TEXT_BODY,
};

// A TEMPLATE command has no schema row, but it is still an active command.
// Keep that state distinct from UNKNOWN so the words that follow its name are
// scanned as values instead of repeatedly competing with a fresh command at
// every position on a semicolon-delimited line.
#define SOFISTIK_DYNAMIC_COMMAND_ID SOFISTIK_COMMAND_COUNT

typedef struct {
  uint32_t module;
  uint32_t command;
  uint8_t text_state;
  bool after_missing_end;
  bool in_legacy_text;
} Scanner;

static bool ascii_equal(int32_t character, char expected) {
  if (character >= 'a' && character <= 'z') {
    character -= 'a' - 'A';
  }
  if (expected >= 'a' && expected <= 'z') {
    expected -= 'a' - 'A';
  }
  return character == expected;
}

static bool is_schema_character(int32_t character) {
  return (character >= 'a' && character <= 'z') ||
         (character >= 'A' && character <= 'Z') ||
         (character >= '0' && character <= '9') || character == '_';
}

static bool is_bare_value_suffix(int32_t character) {
  return character == '.' || character == ':' || character == '+' ||
         character == '-' || character == '/' || character == ',' ||
         character == '\\' || character == '*' || character == '^' ||
         character == '&' || character == '|' || character == '?' ||
         character == '\'';
}

static bool is_bare_value_delimiter(int32_t character) {
  return !character || character == ' ' || character == '\t' ||
         character == '\f' || character == '\r' || character == '\n' ||
         character == ';' || character == '!' || character == '=' ||
         character == '#' || character == '$' || character == '@' || character == '\'' ||
         character == '"' ||
         character == '[' || character == ']' || character == '(' ||
         character == ')' || character == '<' || character == '>';
}

static bool is_root_directive_separator(int32_t character) {
  return !character || character == ' ' || character == '\t' ||
         character == '\f' || character == '\r' || character == '\n' ||
         character == ';' || character == '!';
}

static bool is_internal_value_start(int32_t character) {
  return character == '=' || character == '[' || character == ')' ||
         character == '>';
}

static void extend_bare_with_attached_quote(TSLexer *lexer) {
  if (lexer->lookahead != '\'' && lexer->lookahead != '"') {
    return;
  }
  lexer->advance(lexer, false);
  while (
    lexer->lookahead && lexer->lookahead != ' ' &&
    lexer->lookahead != '\t' && lexer->lookahead != '\f' &&
    lexer->lookahead != '\r' && lexer->lookahead != '\n' &&
    lexer->lookahead != ';' && lexer->lookahead != '!' &&
    lexer->lookahead != '#' && lexer->lookahead != '$' &&
    lexer->lookahead != '@' &&
    lexer->lookahead != '[' && lexer->lookahead != ']' &&
    lexer->lookahead != '(' && lexer->lookahead != ')' &&
    lexer->lookahead != '<' && lexer->lookahead != '>'
  ) {
    lexer->advance(lexer, false);
  }
  lexer->mark_end(lexer);
}

static bool contains_word(
  const char *word,
  const char *const *words,
  size_t count
) {
  for (size_t index = 0; index < count; index++) {
    if (strcmp(words[index], word) == 0) {
      return true;
    }
  }
  return false;
}

static bool is_ascii_digit(char character) {
  return character >= '0' && character <= '9';
}

static bool is_number_text(const char *text) {
  size_t index = 0;
  if (text[index] == '+' || text[index] == '-') {
    index++;
  }

  bool has_integer = false;
  while (is_ascii_digit(text[index])) {
    has_integer = true;
    index++;
  }
  bool has_fraction = false;
  if (text[index] == '.') {
    index++;
    while (is_ascii_digit(text[index])) {
      has_fraction = true;
      index++;
    }
  }
  if (!has_integer && !has_fraction) {
    return false;
  }
  if (text[index] == 'e' || text[index] == 'E') {
    index++;
    if (text[index] == '+' || text[index] == '-') {
      index++;
    }
    bool has_exponent = false;
    while (is_ascii_digit(text[index])) {
      has_exponent = true;
      index++;
    }
    if (!has_exponent) {
      return false;
    }
  }
  while (text[index] == ',') {
    index++;
    if (text[index] == '+' || text[index] == '-') {
      index++;
    }
    bool has_list_integer = false;
    while (is_ascii_digit(text[index])) {
      has_list_integer = true;
      index++;
    }
    bool has_list_fraction = false;
    if (text[index] == '.') {
      index++;
      while (is_ascii_digit(text[index])) {
        has_list_fraction = true;
        index++;
      }
    }
    if (!has_list_integer && !has_list_fraction) {
      return false;
    }
    if (text[index] == 'e' || text[index] == 'E') {
      index++;
      if (text[index] == '+' || text[index] == '-') {
        index++;
      }
      bool has_list_exponent = false;
      while (is_ascii_digit(text[index])) {
        has_list_exponent = true;
        index++;
      }
      if (!has_list_exponent) {
        return false;
      }
    }
  }
  return text[index] == '\0';
}

static bool is_variable_keyword(const char *word) {
  static const char *const words[] = {
    "DBG", "DEL", "LET", "PRT", "RCL", "STO",
  };
  return contains_word(word, words, sizeof(words) / sizeof(words[0]));
}

static bool is_reserved_statement_word(const char *word) {
  static const char *const control_words[] = {
    "ELSE", "ELSEIF", "ENDIF", "ENDLOOP", "EXIT_ITERATION", "IF", "LOOP",
  };
  return contains_word(
    word,
    control_words,
    sizeof(control_words) / sizeof(control_words[0])
  );
}

static void reset_command(Scanner *scanner) {
  scanner->command = SOFISTIK_UNKNOWN_ID;
}

static void reset_context(Scanner *scanner) {
  scanner->module = SOFISTIK_UNKNOWN_ID;
  reset_command(scanner);
  scanner->after_missing_end = false;
  scanner->in_legacy_text = false;
}

static bool emit_unterminated_input_block(Scanner *scanner, TSLexer *lexer) {
  scanner->after_missing_end = true;
  lexer->result_symbol = UNTERMINATED_INPUT_BLOCK;
  return true;
}

static void consume_line(TSLexer *lexer) {
  while (
    lexer->lookahead && lexer->lookahead != '\r' && lexer->lookahead != '\n'
  ) {
    lexer->advance(lexer, false);
  }
}

static bool scan_hash_variable_candidate(TSLexer *lexer) {
  if (lexer->lookahead != '#') {
    return false;
  }
  lexer->advance(lexer, false);

  if (
    (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
    (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
    lexer->lookahead == '_'
  ) {
    while (is_schema_character(lexer->lookahead) || lexer->lookahead == '.') {
      lexer->advance(lexer, false);
    }
  } else if (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
    while (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
      lexer->advance(lexer, false);
    }
  } else {
    return false;
  }

  if (lexer->lookahead != '(') {
    return true;
  }
  unsigned depth = 0;
  do {
    if (lexer->lookahead == '(') {
      depth++;
    } else if (lexer->lookahead == ')') {
      depth--;
    } else if (
      !lexer->lookahead || lexer->lookahead == '\r' ||
      lexer->lookahead == '\n'
    ) {
      return false;
    }
    lexer->advance(lexer, false);
  } while (depth > 0);
  return true;
}

static bool scan_hash_token(
  TSLexer *lexer,
  const bool *valid_symbols,
  bool text_context
) {
  if (lexer->lookahead != '#') {
    return false;
  }
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  if (lexer->lookahead == '(') {
    return false;
  }

  char word[16] = {0};
  size_t length = 0;
  if (
    (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
    (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
    lexer->lookahead == '_'
  ) {
    while (is_schema_character(lexer->lookahead) || lexer->lookahead == '.') {
      int32_t character = lexer->lookahead;
      if (length + 1 < sizeof(word) && character < 128) {
        if (character >= 'a' && character <= 'z') {
          character -= 'a' - 'A';
        }
        word[length++] = (char)character;
      }
      lexer->advance(lexer, false);
    }
  } else if (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
    while (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
      lexer->advance(lexer, false);
    }
  } else {
    if (!valid_symbols[LITERAL_HASH]) {
      return false;
    }
    lexer->result_symbol = LITERAL_HASH;
    return true;
  }

  static const char *const preprocessor_words[] = {
    "DEFINE", "ELSE", "ELSEIF", "ENDDEF", "ENDIF", "IF", "INCLUDE", "UNDEF",
  };
  if (
    contains_word(
      word,
      preprocessor_words,
      sizeof(preprocessor_words) / sizeof(preprocessor_words[0])
    )
  ) {
    if (text_context && valid_symbols[LITERAL_HASH]) {
      lexer->result_symbol = LITERAL_HASH;
      return true;
    }
    if (
      valid_symbols[COMMAND_NAME] || valid_symbols[INVALID_COMMAND] ||
      valid_symbols[DYNAMIC_COMMAND_NAME] || valid_symbols[TEMPLATE_COMMAND_NAME]
    ) {
      return false;
    }
  }
  if (!valid_symbols[HASH_VARIABLE_NAME]) {
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = HASH_VARIABLE_NAME;
  return true;
}

static bool scan_dollar_variable_candidate(TSLexer *lexer) {
  if (lexer->lookahead != '$') {
    return false;
  }
  lexer->advance(lexer, false);
  if (lexer->lookahead != '(') {
    return false;
  }
  lexer->advance(lexer, false);

  bool has_content = false;
  while (
    lexer->lookahead && lexer->lookahead != ')' &&
    lexer->lookahead != '\r' && lexer->lookahead != '\n'
  ) {
    lexer->advance(lexer, false);
    has_content = true;
  }
  if (!has_content || lexer->lookahead != ')') {
    return false;
  }
  lexer->advance(lexer, false);
  return true;
}

static bool scan_string_candidate(TSLexer *lexer, int32_t quote) {
  if (lexer->lookahead != quote) {
    return false;
  }
  lexer->advance(lexer, false);
  while (
    lexer->lookahead && lexer->lookahead != '\r' &&
    lexer->lookahead != '\n'
  ) {
    if (lexer->lookahead != quote) {
      lexer->advance(lexer, false);
      continue;
    }
    lexer->advance(lexer, false);
    if (lexer->lookahead == quote) {
      lexer->advance(lexer, false);
      continue;
    }
    return true;
  }
  return false;
}

static bool scan_unterminated_string(TSLexer *lexer, const bool *valid_symbols) {
  int32_t quote = lexer->lookahead;
  enum TokenType unterminated = quote == '\''
    ? UNTERMINATED_SINGLE_QUOTED_STRING
    : UNTERMINATED_DOUBLE_QUOTED_STRING;
  if (
    (quote != '\'' && quote != '"') ||
    !valid_symbols[unterminated]
  ) {
    return false;
  }

  lexer->advance(lexer, false);
  if (lexer->lookahead == quote) {
    return false;
  }
  while (
    lexer->lookahead && lexer->lookahead != '\r' &&
    lexer->lookahead != '\n'
  ) {
    if (lexer->lookahead != quote) {
      lexer->advance(lexer, false);
      continue;
    }
    lexer->advance(lexer, false);
    if (lexer->lookahead == quote) {
      lexer->advance(lexer, false);
      continue;
    }
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = unterminated;
  return true;
}

static bool scan_interpolated_string_content(
  TSLexer *lexer,
  int32_t quote,
  enum TokenType result_symbol
) {
  bool has_content = false;

  while (
    lexer->lookahead && lexer->lookahead != '\r' &&
    lexer->lookahead != '\n'
  ) {
    if (lexer->lookahead == quote) {
      lexer->mark_end(lexer);
      lexer->advance(lexer, false);
      if (lexer->lookahead == quote) {
        lexer->advance(lexer, false);
        has_content = true;
        continue;
      }
      if (!has_content) {
        return false;
      }
      lexer->result_symbol = result_symbol;
      return true;
    }

    if (lexer->lookahead == '$') {
      lexer->mark_end(lexer);
      if (scan_dollar_variable_candidate(lexer)) {
        if (!has_content) {
          return false;
        }
        lexer->result_symbol = result_symbol;
        return true;
      }
      has_content = true;
      continue;
    }

    lexer->advance(lexer, false);
    has_content = true;
  }

  if (!has_content) {
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = result_symbol;
  return true;
}

static bool scan_slash_comment(TSLexer *lexer, const bool *valid_symbols) {
  lexer->advance(lexer, false);
  if (lexer->lookahead != '/') {
    if (valid_symbols[BARE_WORD]) {
      while (!is_bare_value_delimiter(lexer->lookahead)) {
        lexer->advance(lexer, false);
      }
      lexer->mark_end(lexer);
      lexer->result_symbol = BARE_WORD;
      return true;
    }
    return false;
  }
  lexer->advance(lexer, false);
  consume_line(lexer);
  lexer->mark_end(lexer);
  lexer->result_symbol = COMMENT;
  return true;
}

static uint32_t find_module(const char *name) {
  uint32_t left = 0;
  uint32_t right = SOFISTIK_MODULE_COUNT;
  while (left < right) {
    uint32_t middle = left + (right - left) / 2;
    int comparison = strcmp(SOFISTIK_MODULES[middle].name, name);
    if (comparison < 0) {
      left = middle + 1;
    } else if (comparison > 0) {
      right = middle;
    } else {
      return middle;
    }
  }
  return SOFISTIK_UNKNOWN_ID;
}

static uint32_t find_command_in_range(
  uint32_t start,
  uint32_t count,
  const char *name
) {
  uint32_t left = start;
  uint32_t right = start + count;
  while (left < right) {
    uint32_t middle = left + (right - left) / 2;
    int comparison = strcmp(SOFISTIK_COMMANDS[middle].name, name);
    if (comparison < 0) {
      left = middle + 1;
    } else if (comparison > 0) {
      right = middle;
    } else {
      return middle;
    }
  }
  return SOFISTIK_UNKNOWN_ID;
}

static uint32_t find_command(uint32_t module, const char *name) {
  if (module >= SOFISTIK_MODULE_COUNT) {
    return SOFISTIK_UNKNOWN_ID;
  }
  const SofistikModuleSchema *schema = &SOFISTIK_MODULES[module];
  uint32_t command = find_command_in_range(
    schema->command_start,
    schema->command_count,
    name
  );
  if (command != SOFISTIK_UNKNOWN_ID) {
    return command;
  }
  return find_command_in_range(
    SOFISTIK_BASIC_COMMAND_START,
    SOFISTIK_BASIC_COMMAND_COUNT,
    name
  );
}

static uint32_t find_item(uint32_t command, const char *name) {
  if (command >= SOFISTIK_COMMAND_COUNT) {
    return SOFISTIK_UNKNOWN_ID;
  }
  const SofistikCommandSchema *schema = &SOFISTIK_COMMANDS[command];
  uint32_t left = schema->item_start;
  uint32_t right = schema->item_start + schema->item_count;
  while (left < right) {
    uint32_t middle = left + (right - left) / 2;
    int comparison = strcmp(SOFISTIK_ITEMS[middle], name);
    if (comparison < 0) {
      left = middle + 1;
    } else if (comparison > 0) {
      right = middle;
    } else {
      return middle;
    }
  }
  return SOFISTIK_UNKNOWN_ID;
}

static bool is_command_value(uint32_t command, const char *name) {
  if (command >= SOFISTIK_COMMAND_COUNT) {
    return false;
  }
  const SofistikCommandSchema *schema = &SOFISTIK_COMMANDS[command];
  uint32_t left = schema->value_start;
  uint32_t right = schema->value_start + schema->value_count;
  while (left < right) {
    uint32_t middle = left + (right - left) / 2;
    int comparison = strcmp(SOFISTIK_COMMAND_VALUES[middle], name);
    if (comparison < 0) {
      left = middle + 1;
    } else if (comparison > 0) {
      right = middle;
    } else {
      return true;
    }
  }
  return false;
}

static bool is_text_value_command(uint32_t command) {
  if (command >= SOFISTIK_COMMAND_COUNT) {
    return false;
  }
  const char *name = SOFISTIK_COMMANDS[command].name;
  return strcmp(name, "TXA") == 0 || strcmp(name, "TXAB") == 0 ||
         strcmp(name, "TXB") == 0 || strcmp(name, "TXBB") == 0 ||
         strcmp(name, "TXE") == 0 || strcmp(name, "TXEB") == 0;
}

static bool is_legacy_text_start(uint32_t command) {
  if (command >= SOFISTIK_COMMAND_COUNT) {
    return false;
  }
  const char *name = SOFISTIK_COMMANDS[command].name;
  return strcmp(name, "TXAB") == 0 || strcmp(name, "TXBB") == 0 ||
         strcmp(name, "TXEB") == 0;
}

static bool scan_non_word_bare(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid_symbols,
  bool *reserved_root_word,
  bool *defer_to_internal_lexer,
  uint32_t skipped_columns
) {
  if (
    is_schema_character(lexer->lookahead) ||
    is_bare_value_delimiter(lexer->lookahead)
  ) {
    return false;
  }

  bool can_terminate_input = valid_symbols[UNTERMINATED_INPUT_BLOCK];
  char prefix[16] = {0};
  size_t length = 0;
  while (!is_bare_value_delimiter(lexer->lookahead)) {
    int32_t character = lexer->lookahead;
    if (length + 1 < sizeof(prefix) && character < 128) {
      if (character >= 'a' && character <= 'z') {
        character -= 'a' - 'A';
      }
      prefix[length++] = (char)character;
    }
    lexer->advance(lexer, false);
  }
  prefix[length] = '\0';

  if (!(valid_symbols[BARE_WORD] && !valid_symbols[IGNORED_TEXT])) {
    if (
      valid_symbols[APPLY_SIGIL] &&
      (strcmp(prefix, "+APPLY") == 0 || strcmp(prefix, "-APPLY") == 0)
    ) {
      lexer->mark_end(lexer);
      reset_context(scanner);
      lexer->result_symbol = APPLY_SIGIL;
      return true;
    }
    if (
      valid_symbols[SYS_SIGIL] &&
      (strcmp(prefix, "+SYS") == 0 || strcmp(prefix, "-SYS") == 0)
    ) {
      lexer->mark_end(lexer);
      reset_context(scanner);
      lexer->result_symbol = SYS_SIGIL;
      return true;
    }
  }

  if (
    valid_symbols[BARE_WORD] &&
    (!valid_symbols[IGNORED_TEXT] ||
     scanner->command != SOFISTIK_UNKNOWN_ID) &&
    (is_number_text(prefix) ||
     ((prefix[0] == ':' || prefix[0] == '~' || prefix[0] == '\\') &&
      ((prefix[1] >= 'A' && prefix[1] <= 'Z') || prefix[1] == '_')))
  ) {
    *defer_to_internal_lexer = true;
    return false;
  }

  if (
    (strcmp(prefix, "+PROG") == 0 || strcmp(prefix, "-PROG") == 0 ||
     strcmp(prefix, "+APPLY") == 0 || strcmp(prefix, "-APPLY") == 0 ||
     strcmp(prefix, "+SYS") == 0 || strcmp(prefix, "-SYS") == 0) &&
    is_root_directive_separator(lexer->lookahead)
  ) {
    if (can_terminate_input) {
      return emit_unterminated_input_block(scanner, lexer);
    }
    bool at_root_line_start =
      lexer->get_column(lexer) == skipped_columns + strlen(prefix);
    if (
      valid_symbols[BARE_WORD] && !valid_symbols[IGNORED_TEXT] &&
      !at_root_line_start && !scanner->after_missing_end
    ) {
      lexer->mark_end(lexer);
      lexer->result_symbol = BARE_WORD;
      return true;
    }
    if (
      strcmp(prefix, "+APPLY") == 0 || strcmp(prefix, "-APPLY") == 0 ||
      strcmp(prefix, "+SYS") == 0 || strcmp(prefix, "-SYS") == 0
    ) {
      reset_context(scanner);
    }
    *reserved_root_word = true;
    return false;
  }

  if (!valid_symbols[BARE_WORD]) {
    return false;
  }

  extend_bare_with_attached_quote(lexer);
  lexer->mark_end(lexer);
  lexer->result_symbol = BARE_WORD;
  return true;
}

static bool is_global_command(const char *name) {
  uint32_t left = 0;
  uint32_t right = SOFISTIK_GLOBAL_COMMAND_COUNT;
  while (left < right) {
    uint32_t middle = left + (right - left) / 2;
    int comparison = strcmp(SOFISTIK_GLOBAL_COMMANDS[middle], name);
    if (comparison < 0) {
      left = middle + 1;
    } else if (comparison > 0) {
      right = middle;
    } else {
      return true;
    }
  }
  return false;
}

static bool is_template_module(uint32_t module) {
  return module < SOFISTIK_MODULE_COUNT &&
         strcmp(SOFISTIK_MODULES[module].name, "TEMPLATE") == 0;
}

static bool read_word(
  TSLexer *lexer,
  char *word,
  size_t capacity,
  bool *contextual,
  bool *followed_by_hash,
  bool mark_word_end
) {
  if (!is_schema_character(lexer->lookahead)) {
    return false;
  }

  size_t length = 0;
  bool overflow = false;
  while (is_schema_character(lexer->lookahead)) {
    int32_t character = lexer->lookahead;
    if (length + 1 < capacity) {
      if (character >= 'a' && character <= 'z') {
        character -= 'a' - 'A';
      }
      word[length++] = (char)character;
    } else {
      overflow = true;
    }
    lexer->advance(lexer, false);
  }
  word[length] = '\0';

  *followed_by_hash = lexer->lookahead == '#';
  *contextual = !overflow && !is_bare_value_suffix(lexer->lookahead);
  if (!*contextual) {
    while (!is_bare_value_delimiter(lexer->lookahead)) {
      int32_t character = lexer->lookahead;
      if (length + 1 < capacity && character < 128) {
        if (character >= 'a' && character <= 'z') {
          character -= 'a' - 'A';
        }
        word[length++] = (char)character;
      } else {
        overflow = true;
      }
      lexer->advance(lexer, false);
    }
    word[length] = '\0';
    if (overflow) {
      word[0] = '\0';
    }
  }
  if (mark_word_end) {
    lexer->mark_end(lexer);
  }
  return true;
}

static bool scan_word(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid_symbols,
  bool *reserved_root_word,
  bool *defer_to_internal_lexer,
  bool at_line_start,
  bool line_start_known,
  uint32_t skipped_columns
) {
  char word[128] = {0};
  bool contextual = false;
  bool followed_by_hash = false;
  bool can_terminate_input = valid_symbols[UNTERMINATED_INPUT_BLOCK];
  if (!read_word(
        lexer,
        word,
        sizeof(word),
        &contextual,
        &followed_by_hash,
        !can_terminate_input
      )) {
    return false;
  }
  bool reserved_root_statement =
    strcmp(word, "PROG") == 0 || strcmp(word, "APPLY") == 0 ||
    strcmp(word, "SYS") == 0;
  if (
    valid_symbols[BARE_WORD] &&
    (!valid_symbols[IGNORED_TEXT] ||
     scanner->command != SOFISTIK_UNKNOWN_ID) &&
    is_ascii_digit(word[0])
  ) {
    *defer_to_internal_lexer = true;
    return false;
  }
  if (!contextual) {
    if (
      valid_symbols[ITEM_NAME] &&
      find_item(scanner->command, word) != SOFISTIK_UNKNOWN_ID
    ) {
      lexer->mark_end(lexer);
      lexer->result_symbol = ITEM_NAME;
      return true;
    }
    if (valid_symbols[BARE_WORD]) {
      extend_bare_with_attached_quote(lexer);
      lexer->result_symbol = BARE_WORD;
      return true;
    }
    return false;
  }
  if (can_terminate_input && reserved_root_statement) {
    return emit_unterminated_input_block(scanner, lexer);
  }
  if (can_terminate_input) {
    lexer->mark_end(lexer);
  }
  if (!(valid_symbols[BARE_WORD] && !valid_symbols[IGNORED_TEXT])) {
    if (valid_symbols[APPLY_SIGIL] && strcmp(word, "APPLY") == 0) {
      reset_context(scanner);
      lexer->result_symbol = APPLY_SIGIL;
      return true;
    }
    if (valid_symbols[SYS_SIGIL] && strcmp(word, "SYS") == 0) {
      reset_context(scanner);
      lexer->result_symbol = SYS_SIGIL;
      return true;
    }
  }
  if (valid_symbols[END_KEYWORD] &&
      (strcmp(word, "END") == 0 || strcmp(word, "ENDE") == 0)) {
    reset_command(scanner);
    scanner->in_legacy_text = false;
    lexer->result_symbol = END_KEYWORD;
    return true;
  }

  if (valid_symbols[MODULE_NAME] || valid_symbols[INVALID_MODULE]) {
    uint32_t module = find_module(word);
    reset_context(scanner);
    if (module != SOFISTIK_UNKNOWN_ID && valid_symbols[MODULE_NAME]) {
      scanner->module = module;
      lexer->result_symbol = MODULE_NAME;
      return true;
    }
    if (valid_symbols[INVALID_MODULE]) {
      lexer->result_symbol = INVALID_MODULE;
      return true;
    }
  }

  if (scanner->in_legacy_text) {
    if (
      valid_symbols[COMMAND_NAME] && valid_symbols[END_KEYWORD] &&
      strcmp(word, "TXEN") == 0
    ) {
      uint32_t command = find_command(scanner->module, word);
      if (command != SOFISTIK_UNKNOWN_ID) {
        scanner->command = command;
        scanner->in_legacy_text = false;
        lexer->result_symbol = COMMAND_NAME;
        return true;
      }
    }
    if (valid_symbols[BARE_WORD]) {
      extend_bare_with_attached_quote(lexer);
      lexer->result_symbol = BARE_WORD;
      return true;
    }
    return false;
  }

  if (valid_symbols[DYNAMIC_COMMAND_NAME]) {
    scanner->command = SOFISTIK_DYNAMIC_COMMAND_ID;
    lexer->result_symbol = DYNAMIC_COMMAND_NAME;
    return true;
  }

  if (
    followed_by_hash && valid_symbols[VARIABLE_KEYWORD] &&
    is_variable_keyword(word)
  ) {
    lexer->result_symbol = VARIABLE_KEYWORD;
    return true;
  }

  if (reserved_root_statement) {
    if (!line_start_known && scanner->command != SOFISTIK_UNKNOWN_ID) {
      at_line_start =
        lexer->get_column(lexer) == skipped_columns + strlen(word);
    }
    if (
      scanner->after_missing_end || at_line_start ||
      (scanner->command == SOFISTIK_UNKNOWN_ID && valid_symbols[IGNORED_TEXT])
    ) {
      if (strcmp(word, "APPLY") == 0 || strcmp(word, "SYS") == 0) {
        reset_context(scanner);
      }
      *reserved_root_word = true;
      return false;
    }
  }

  if (is_reserved_statement_word(word)) {
    if (valid_symbols[IGNORED_TEXT]) {
      *reserved_root_word = true;
    }
    if (
      valid_symbols[DYNAMIC_COMMAND_NAME] || valid_symbols[TEMPLATE_COMMAND_NAME] ||
      valid_symbols[IGNORED_TEXT]
    ) {
      return false;
    }
  }

  uint32_t item = valid_symbols[ITEM_NAME]
    ? find_item(scanner->command, word)
    : SOFISTIK_UNKNOWN_ID;

  if (
    (valid_symbols[COMMAND_NAME] || valid_symbols[INVALID_COMMAND]) &&
    !(valid_symbols[IGNORED_TEXT] && scanner->module == SOFISTIK_UNKNOWN_ID)
  ) {
    uint32_t command = find_command(scanner->module, word);
    if (command != SOFISTIK_UNKNOWN_ID && valid_symbols[COMMAND_NAME]) {
      scanner->command = command;
      scanner->in_legacy_text = is_legacy_text_start(command);
      lexer->result_symbol = COMMAND_NAME;
      return true;
    }
    if (valid_symbols[TEMPLATE_COMMAND_NAME] && is_template_module(scanner->module)) {
      scanner->command = SOFISTIK_DYNAMIC_COMMAND_ID;
      lexer->result_symbol = TEMPLATE_COMMAND_NAME;
      return true;
    }
    if (
      valid_symbols[INVALID_COMMAND] &&
      scanner->text_state == OUTSIDE_TEXT &&
      valid_symbols[END_KEYWORD] &&
      scanner->module != SOFISTIK_UNKNOWN_ID &&
      command == SOFISTIK_UNKNOWN_ID &&
      item == SOFISTIK_UNKNOWN_ID &&
      !is_text_value_command(scanner->command) &&
      !is_command_value(scanner->command, word) &&
      is_global_command(word)
    ) {
      reset_command(scanner);
      lexer->result_symbol = INVALID_COMMAND;
      return true;
    }
  }

  if (valid_symbols[TEMPLATE_COMMAND_NAME] && is_template_module(scanner->module)) {
    scanner->command = SOFISTIK_DYNAMIC_COMMAND_ID;
    lexer->result_symbol = TEMPLATE_COMMAND_NAME;
    return true;
  }

  if (item != SOFISTIK_UNKNOWN_ID) {
    lexer->result_symbol = ITEM_NAME;
    return true;
  }

  if (valid_symbols[VARIABLE_KEYWORD] && is_variable_keyword(word)) {
    lexer->result_symbol = VARIABLE_KEYWORD;
    return true;
  }

  if (
    valid_symbols[BARE_WORD] &&
    !(valid_symbols[COMMAND_NAME] && is_reserved_statement_word(word)) &&
    (!(scanner->module != SOFISTIK_UNKNOWN_ID &&
       scanner->command == SOFISTIK_UNKNOWN_ID && valid_symbols[COMMAND_NAME]) ||
     valid_symbols[IGNORED_TEXT])
  ) {
    extend_bare_with_attached_quote(lexer);
    lexer->result_symbol = BARE_WORD;
    return true;
  }
  return false;
}

static bool scan_dollar(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  bool can_terminate_input = valid_symbols[UNTERMINATED_INPUT_BLOCK];
  lexer->advance(lexer, false);

  if (lexer->lookahead == '(') {
    return false;
  }

  if (lexer->lookahead == '$') {
    lexer->advance(lexer, false);
    if (valid_symbols[CONTINUATION]) {
      consume_line(lexer);
      lexer->mark_end(lexer);
      lexer->result_symbol = CONTINUATION;
      return true;
    }
    consume_line(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = COMMENT;
    return true;
  }

  const char *prog = "PROG";
  const char *apply = "APPLY";
  size_t index = 0;
  bool could_be_prog = true;
  bool could_be_apply = true;

  while (lexer->lookahead && (could_be_prog || could_be_apply)) {
    if (could_be_prog) {
      could_be_prog = prog[index] && ascii_equal(lexer->lookahead, prog[index]);
    }
    if (could_be_apply) {
      could_be_apply = apply[index] && ascii_equal(lexer->lookahead, apply[index]);
    }
    if (!could_be_prog && !could_be_apply) {
      break;
    }
    lexer->advance(lexer, false);
    index++;

    if (could_be_prog && !prog[index] && is_root_directive_separator(lexer->lookahead)) {
      if (can_terminate_input) {
        return emit_unterminated_input_block(scanner, lexer);
      }
      if (valid_symbols[DOLLAR_PROG]) {
        reset_context(scanner);
        lexer->mark_end(lexer);
        lexer->result_symbol = DOLLAR_PROG;
        return true;
      }
      could_be_prog = false;
    }
    if (could_be_apply && !apply[index] && is_root_directive_separator(lexer->lookahead)) {
      if (can_terminate_input) {
        return emit_unterminated_input_block(scanner, lexer);
      }
      if (valid_symbols[DOLLAR_APPLY]) {
        reset_context(scanner);
        lexer->mark_end(lexer);
        lexer->result_symbol = DOLLAR_APPLY;
        return true;
      }
      could_be_apply = false;
    }
  }

  consume_line(lexer);
  lexer->mark_end(lexer);
  lexer->result_symbol = COMMENT;
  return true;
}

static bool scan_sequence_generator_start(
  TSLexer *lexer,
  const bool *valid_symbols
) {
  if (lexer->lookahead != '(') {
    return false;
  }
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);

  unsigned component_count = 0;
  bool in_component = false;
  while (lexer->lookahead) {
    if (
      lexer->lookahead == '\r' || lexer->lookahead == '\n' ||
      lexer->lookahead == '!' || lexer->lookahead == ';'
    ) {
      if (valid_symbols[LITERAL_OPENING_PARENTHESIS]) {
        lexer->result_symbol = LITERAL_OPENING_PARENTHESIS;
        return true;
      }
      return false;
    }
    if (lexer->lookahead == ')') {
      if (in_component) {
        component_count++;
      }
      if (component_count < 2) {
        return false;
      }
      lexer->result_symbol = SEQUENCE_GENERATOR_START;
      return true;
    }
    if (
      lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
      lexer->lookahead == '\f'
    ) {
      if (in_component) {
        component_count++;
        in_component = false;
      }
      lexer->advance(lexer, false);
      continue;
    }
    if (lexer->lookahead == '(') {
      return false;
    }
    if (lexer->lookahead == '#') {
      if (!scan_hash_variable_candidate(lexer)) {
        return false;
      }
      in_component = true;
      continue;
    }
    if (lexer->lookahead == '$') {
      if (!scan_dollar_variable_candidate(lexer)) {
        return false;
      }
      in_component = true;
      continue;
    }
    if (lexer->lookahead == '\'' || lexer->lookahead == '"') {
      int32_t quote = lexer->lookahead;
      if (!scan_string_candidate(lexer, quote)) {
        return false;
      }
      in_component = true;
      continue;
    }
    lexer->advance(lexer, false);
    in_component = true;
  }
  if (valid_symbols[LITERAL_OPENING_PARENTHESIS]) {
    lexer->result_symbol = LITERAL_OPENING_PARENTHESIS;
    return true;
  }
  return false;
}

static bool scan_generator_separator(TSLexer *lexer) {
  bool has_space = false;
  while (
    lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
    lexer->lookahead == '\f'
  ) {
    lexer->advance(lexer, false);
    has_space = true;
  }
  if (!has_space) {
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = GENERATOR_SEPARATOR;
  return true;
}

static bool scan_preprocessor_literal(
  TSLexer *lexer,
  const bool *valid_symbols
) {
  bool has_content = false;
  while (
    lexer->lookahead && lexer->lookahead != '\r' &&
    lexer->lookahead != '\n' && lexer->lookahead != '!' &&
    lexer->lookahead != '#' && lexer->lookahead != '$' &&
    lexer->lookahead != '\'' && lexer->lookahead != '"'
  ) {
    if (lexer->lookahead == '/') {
      lexer->mark_end(lexer);
      lexer->advance(lexer, false);
      if (lexer->lookahead == '/') {
        if (!has_content) {
          if (!valid_symbols[COMMENT]) {
            return false;
          }
          lexer->advance(lexer, false);
          consume_line(lexer);
          lexer->mark_end(lexer);
          lexer->result_symbol = COMMENT;
          return true;
        }
        lexer->result_symbol = PREPROCESSOR_LITERAL;
        return true;
      }
      has_content = true;
      continue;
    }
    lexer->advance(lexer, false);
    has_content = true;
  }
  if (!has_content) {
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = PREPROCESSOR_LITERAL;
  return true;
}

static bool scan_preprocessor_recovery_value(TSLexer *lexer) {
  if (lexer->lookahead != '=') {
    return false;
  }
  lexer->advance(lexer, false);
  while (
    lexer->lookahead && lexer->lookahead != '\r' &&
    lexer->lookahead != '\n' && lexer->lookahead != '!' &&
    lexer->lookahead != '$'
  ) {
    lexer->advance(lexer, false);
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = PREPROCESSOR_RECOVERY_VALUE;
  return true;
}

static bool scan_text_start_open(Scanner *scanner, TSLexer *lexer) {
  if (lexer->lookahead != '<') {
    return false;
  }
  lexer->advance(lexer, false);

  const char *text = "TEXT";
  size_t index = 0;
  while (text[index] && ascii_equal(lexer->lookahead, text[index])) {
    lexer->advance(lexer, false);
    index++;
  }
  if (
    text[index] ||
    (lexer->lookahead != '>' && lexer->lookahead != ',' &&
     lexer->lookahead != ' ' && lexer->lookahead != '\t')
  ) {
    return false;
  }

  lexer->mark_end(lexer);
  scanner->text_state = IN_TEXT_HEADER;
  lexer->result_symbol = TEXT_START_OPEN;
  return true;
}

static bool scan_text_start_close(Scanner *scanner, TSLexer *lexer) {
  if (lexer->lookahead != '>') {
    return false;
  }
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  scanner->text_state = IN_TEXT_BODY;
  lexer->result_symbol = TEXT_START_CLOSE;
  return true;
}

static bool scan_text_end(Scanner *scanner, TSLexer *lexer) {
  if (lexer->lookahead != '<') {
    return false;
  }
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  if (lexer->lookahead != '/' && lexer->lookahead != '\\') {
    lexer->result_symbol = TEXT_CONTENT;
    return true;
  }
  lexer->advance(lexer, false);

  const char *text = "TEXT";
  size_t index = 0;
  while (text[index] && ascii_equal(lexer->lookahead, text[index])) {
    lexer->advance(lexer, false);
    index++;
  }
  if (text[index] || lexer->lookahead != '>') {
    lexer->result_symbol = TEXT_CONTENT;
    return true;
  }
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  scanner->text_state = OUTSIDE_TEXT;
  lexer->result_symbol = TEXT_END;
  return true;
}

static bool scan_text_fragment(TSLexer *lexer) {
  int32_t marker = lexer->lookahead;
  if (marker != '#' && marker != '$' && marker != '\'' && marker != '"') {
    return false;
  }

  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  bool is_embedded_value = false;

  if (marker == '#') {
    if (
      (lexer->lookahead >= 'a' && lexer->lookahead <= 'z') ||
      (lexer->lookahead >= 'A' && lexer->lookahead <= 'Z') ||
      lexer->lookahead == '_'
    ) {
      is_embedded_value = true;
    } else if (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
      is_embedded_value = true;
    }
  } else if (marker == '$') {
    if (lexer->lookahead == '(') {
      lexer->advance(lexer, false);
      bool has_content = false;
      while (
        lexer->lookahead && lexer->lookahead != ')' &&
        lexer->lookahead != '\r' && lexer->lookahead != '\n'
      ) {
        lexer->advance(lexer, false);
        has_content = true;
      }
      is_embedded_value = has_content && lexer->lookahead == ')';
    }
  } else {
    while (
      lexer->lookahead && lexer->lookahead != '\r' &&
      lexer->lookahead != '\n'
    ) {
      if (lexer->lookahead != marker) {
        lexer->advance(lexer, false);
        continue;
      }
      lexer->advance(lexer, false);
      if (lexer->lookahead == marker) {
        lexer->advance(lexer, false);
        continue;
      }
      is_embedded_value = true;
      break;
    }
  }

  if (is_embedded_value) {
    return false;
  }
  lexer->result_symbol = TEXT_FRAGMENT;
  return true;
}

static bool scan_text_content(TSLexer *lexer) {
  bool has_content = false;
  bool previous_is_word = false;

  while (lexer->lookahead) {
    if (
      lexer->lookahead == '#' || lexer->lookahead == '$' ||
      ((lexer->lookahead == '\'' || lexer->lookahead == '"') &&
       !previous_is_word)
    ) {
      lexer->mark_end(lexer);
      if (!has_content) {
        return false;
      }
      lexer->result_symbol = TEXT_CONTENT;
      return true;
    }

    if (lexer->lookahead == '<') {
      lexer->mark_end(lexer);
      lexer->advance(lexer, false);
      if (lexer->lookahead == '/' || lexer->lookahead == '\\') {
        lexer->advance(lexer, false);
        const char *text = "TEXT";
        size_t index = 0;
        while (text[index] && ascii_equal(lexer->lookahead, text[index])) {
          lexer->advance(lexer, false);
          index++;
        }
        if (!text[index] && lexer->lookahead == '>') {
          if (!has_content) {
            return false;
          }
          lexer->result_symbol = TEXT_CONTENT;
          return true;
        }
      }
      has_content = true;
      previous_is_word = false;
      continue;
    }

    previous_is_word = is_schema_character(lexer->lookahead);
    lexer->advance(lexer, false);
    has_content = true;
  }

  if (!has_content) {
    return false;
  }
  lexer->mark_end(lexer);
  lexer->result_symbol = TEXT_CONTENT;
  return true;
}

static void write_u32(char *buffer, uint32_t value) {
  buffer[0] = (char)(value & 0xff);
  buffer[1] = (char)((value >> 8) & 0xff);
  buffer[2] = (char)((value >> 16) & 0xff);
  buffer[3] = (char)((value >> 24) & 0xff);
}

static uint32_t read_u32(const char *buffer) {
  return (uint32_t)(uint8_t)buffer[0] |
         ((uint32_t)(uint8_t)buffer[1] << 8) |
         ((uint32_t)(uint8_t)buffer[2] << 16) |
         ((uint32_t)(uint8_t)buffer[3] << 24);
}

void *tree_sitter_sofistik_external_scanner_create(void) {
  Scanner *scanner = calloc(1, sizeof(Scanner));
  reset_context(scanner);
  return scanner;
}

bool tree_sitter_sofistik_external_scanner_scan(
  void *payload,
  TSLexer *lexer,
  const bool *valid_symbols
) {
  Scanner *scanner = payload;

  // Tree-sitter marks every external token valid during error recovery. The
  // sentinel is never part of a successful production; checking the complete
  // set avoids confusing its ordinary always-valid state with recovery.
  bool all_symbols_valid = valid_symbols[ERROR_SENTINEL];
  for (unsigned index = 0; index < ERROR_SENTINEL; index++) {
    all_symbols_valid = all_symbols_valid && valid_symbols[index];
  }
  if (all_symbols_valid) {
    if (
      scanner->text_state == OUTSIDE_TEXT && lexer->lookahead == '<' &&
      valid_symbols[TEXT_START_OPEN]
    ) {
      return scan_text_start_open(scanner, lexer);
    }
    if (
      scanner->text_state == IN_TEXT_HEADER && lexer->lookahead == '>' &&
      valid_symbols[TEXT_START_CLOSE]
    ) {
      return scan_text_start_close(scanner, lexer);
    }
    if (scanner->text_state == IN_TEXT_BODY) {
      if (valid_symbols[TEXT_END] && lexer->lookahead == '<') {
        return scan_text_end(scanner, lexer);
      }
      if (
        lexer->lookahead == '#' &&
        (valid_symbols[HASH_VARIABLE_NAME] || valid_symbols[LITERAL_HASH])
      ) {
        return scan_hash_token(lexer, valid_symbols, true);
      }
      if (
        valid_symbols[TEXT_FRAGMENT] &&
        (lexer->lookahead == '#' || lexer->lookahead == '$' ||
         lexer->lookahead == '\'' || lexer->lookahead == '"')
      ) {
        return scan_text_fragment(lexer);
      }
      if (valid_symbols[TEXT_CONTENT]) {
        return scan_text_content(lexer);
      }
    }
    if (
      valid_symbols[PREPROCESSOR_RECOVERY_VALUE] &&
      scan_preprocessor_recovery_value(lexer)
    ) {
      return true;
    }
    return false;
  }

  if (valid_symbols[SINGLE_STRING_CONTENT]) {
    return scan_interpolated_string_content(
      lexer,
      '\'',
      SINGLE_STRING_CONTENT
    );
  }

  if (valid_symbols[DOUBLE_STRING_CONTENT]) {
    return scan_interpolated_string_content(
      lexer,
      '"',
      DOUBLE_STRING_CONTENT
    );
  }

  if (
    scanner->text_state == OUTSIDE_TEXT && lexer->lookahead == '<' &&
    valid_symbols[TEXT_START_OPEN]
  ) {
    return scan_text_start_open(scanner, lexer);
  }

  if (
    scanner->text_state == IN_TEXT_HEADER && lexer->lookahead == '>' &&
    valid_symbols[TEXT_START_CLOSE]
  ) {
    return scan_text_start_close(scanner, lexer);
  }

  if (scanner->text_state == IN_TEXT_BODY) {
    if (valid_symbols[TEXT_END] && lexer->lookahead == '<') {
      return scan_text_end(scanner, lexer);
    }
    if (
      lexer->lookahead == '#' &&
      (valid_symbols[HASH_VARIABLE_NAME] || valid_symbols[LITERAL_HASH])
    ) {
      return scan_hash_token(lexer, valid_symbols, true);
    }
    if (
      valid_symbols[TEXT_FRAGMENT] &&
      (lexer->lookahead == '#' || lexer->lookahead == '$' ||
       lexer->lookahead == '\'' || lexer->lookahead == '"')
    ) {
      return scan_text_fragment(lexer);
    }
    if (valid_symbols[TEXT_CONTENT]) {
      return scan_text_content(lexer);
    }
  }

  if (valid_symbols[END_OF_FILE] && !lexer->lookahead) {
    lexer->result_symbol = END_OF_FILE;
    return true;
  }

  if (valid_symbols[UNTERMINATED_INPUT_BLOCK] && !lexer->lookahead) {
    return emit_unterminated_input_block(scanner, lexer);
  }

  if (
    valid_symbols[GENERATOR_SEPARATOR] &&
    (lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
     lexer->lookahead == '\f')
  ) {
    return scan_generator_separator(lexer);
  }

  bool needs_line_start = valid_symbols[BARE_WORD] && valid_symbols[IGNORED_TEXT];
  bool at_line_start = needs_line_start && lexer->get_column(lexer) == 0;

  if (valid_symbols[UNTERMINATED_INPUT_BLOCK]) {
    lexer->mark_end(lexer);
  }

  uint32_t skipped_columns = 0;
  while (
    lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
    lexer->lookahead == '\f' || lexer->lookahead == 0xfeff ||
    lexer->lookahead == 0x00ef ||
    lexer->lookahead == 0x00bb || lexer->lookahead == 0x00bf
  ) {
    lexer->advance(lexer, true);
    skipped_columns++;
  }

  if (valid_symbols[END_OF_FILE] && !lexer->lookahead) {
    lexer->result_symbol = END_OF_FILE;
    return true;
  }

  if (valid_symbols[UNTERMINATED_INPUT_BLOCK] && !lexer->lookahead) {
    return emit_unterminated_input_block(scanner, lexer);
  }

  if (
    scanner->text_state == OUTSIDE_TEXT && lexer->lookahead == '<' &&
    valid_symbols[TEXT_START_OPEN]
  ) {
    return scan_text_start_open(scanner, lexer);
  }

  if (valid_symbols[VALUE_SEPARATOR] && lexer->lookahead == ',') {
    lexer->advance(lexer, false);
    lexer->mark_end(lexer);
    lexer->result_symbol = VALUE_SEPARATOR;
    return true;
  }

  if (
    (lexer->lookahead == '\'' || lexer->lookahead == '"') &&
    valid_symbols[IGNORED_TEXT] && !valid_symbols[BARE_WORD]
  ) {
    consume_line(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = IGNORED_TEXT;
    return true;
  }

  if (lexer->lookahead == '\'' || lexer->lookahead == '"') {
    return scan_unterminated_string(lexer, valid_symbols);
  }

  if (
    lexer->lookahead == '#' &&
    (valid_symbols[HASH_VARIABLE_NAME] || valid_symbols[LITERAL_HASH])
  ) {
    return scan_hash_token(lexer, valid_symbols, false);
  }

  if (lexer->lookahead == '$') {
    return scan_dollar(scanner, lexer, valid_symbols);
  }

  if (
    (valid_symbols[SEQUENCE_GENERATOR_START] ||
     valid_symbols[LITERAL_OPENING_PARENTHESIS]) &&
    lexer->lookahead == '(' &&
    scan_sequence_generator_start(lexer, valid_symbols)
  ) {
    return true;
  }

  if (
    valid_symbols[PREPROCESSOR_LITERAL] &&
    scan_preprocessor_literal(lexer, valid_symbols)
  ) {
    return true;
  }

  if (valid_symbols[COMMENT] && lexer->lookahead == '!') {
    consume_line(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = COMMENT;
    return true;
  }

  if (valid_symbols[COMMENT] && lexer->lookahead == '/') {
    return scan_slash_comment(lexer, valid_symbols);
  }

  int32_t initial_lookahead = lexer->lookahead;
  bool has_ignored_text_start =
    lexer->lookahead && lexer->lookahead != '\r' && lexer->lookahead != '\n';
  bool reserved_root_word = false;
  bool defer_to_internal_lexer =
    valid_symbols[BARE_WORD] && valid_symbols[IGNORED_TEXT] &&
    scanner->command != SOFISTIK_UNKNOWN_ID &&
    is_internal_value_start(initial_lookahead);
  if (
    scan_non_word_bare(
      scanner,
      lexer,
      valid_symbols,
      &reserved_root_word,
      &defer_to_internal_lexer,
      skipped_columns
    )
  ) {
    return true;
  }
  if (scan_word(
        scanner,
        lexer,
        valid_symbols,
        &reserved_root_word,
        &defer_to_internal_lexer,
        at_line_start,
        needs_line_start,
        skipped_columns
      )) {
    return true;
  }
  if (
    valid_symbols[IGNORED_TEXT] && has_ignored_text_start &&
    !reserved_root_word && !defer_to_internal_lexer &&
    initial_lookahead != '#' &&
    initial_lookahead != '<' && initial_lookahead != '@'
  ) {
    consume_line(lexer);
    lexer->mark_end(lexer);
    lexer->result_symbol = IGNORED_TEXT;
    return true;
  }
  return false;
}

unsigned tree_sitter_sofistik_external_scanner_serialize(
  void *payload,
  char *buffer
) {
  Scanner *scanner = payload;
  write_u32(buffer, scanner->module);
  write_u32(buffer + 4, scanner->command);
  buffer[8] = (char)scanner->text_state;
  buffer[9] = scanner->after_missing_end ? 1 : 0;
  buffer[10] = scanner->in_legacy_text ? 1 : 0;
  return 11;
}

void tree_sitter_sofistik_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  Scanner *scanner = payload;
  reset_context(scanner);
  scanner->text_state = OUTSIDE_TEXT;
  if (length < 9) {
    return;
  }
  scanner->module = read_u32(buffer);
  scanner->command = read_u32(buffer + 4);
  scanner->text_state = (uint8_t)buffer[8];
  scanner->after_missing_end = length >= 10 && buffer[9] != 0;
  scanner->in_legacy_text = length >= 11 && buffer[10] != 0;
  if (scanner->module >= SOFISTIK_MODULE_COUNT) {
    scanner->module = SOFISTIK_UNKNOWN_ID;
  }
  if (scanner->command > SOFISTIK_DYNAMIC_COMMAND_ID) {
    scanner->command = SOFISTIK_UNKNOWN_ID;
  }
  if (scanner->text_state > IN_TEXT_BODY) {
    scanner->text_state = OUTSIDE_TEXT;
  }
}

void tree_sitter_sofistik_external_scanner_destroy(void *payload) {
  free(payload);
}
