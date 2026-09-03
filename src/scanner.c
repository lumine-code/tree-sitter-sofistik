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
  INVALID_ITEM,
  BARE_WORD,
  DYNAMIC_COMMAND_NAME,
  TEMPLATE_COMMAND_NAME,
  END_KEYWORD,
  VARIABLE_KEYWORD,
  DOLLAR_PROG,
  DOLLAR_APPLY,
  SEQUENCE_GENERATOR_START,
  PARENTHESIZED_EXPRESSION_START,
  PREPROCESSOR_LITERAL,
  CONTINUATION,
  COMMENT,
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
         character == '&' || character == '|' || character == '?';
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
  return is_variable_keyword(word) ||
         contains_word(
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
    while (is_schema_character(lexer->lookahead)) {
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
  lexer->advance(lexer, false);
  while (
    lexer->lookahead && lexer->lookahead != ')' &&
    lexer->lookahead != '\r' && lexer->lookahead != '\n'
  ) {
    lexer->advance(lexer, false);
  }
  if (lexer->lookahead != ')') {
    return false;
  }
  lexer->advance(lexer, false);
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
  for (uint32_t index = 0; index < SOFISTIK_MODULE_COUNT; index++) {
    if (strcmp(SOFISTIK_MODULES[index].name, name) == 0) {
      return index;
    }
  }
  return SOFISTIK_UNKNOWN_ID;
}

static uint32_t find_command_in_range(
  uint32_t start,
  uint32_t count,
  const char *name
) {
  for (uint32_t offset = 0; offset < count; offset++) {
    uint32_t index = start + offset;
    if (strcmp(SOFISTIK_COMMANDS[index].name, name) == 0) {
      return index;
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
  for (uint32_t offset = 0; offset < schema->item_count; offset++) {
    uint32_t index = schema->item_start + offset;
    if (strcmp(SOFISTIK_ITEMS[index], name) == 0) {
      return index;
    }
  }
  return SOFISTIK_UNKNOWN_ID;
}

static bool scan_non_word_bare(
  TSLexer *lexer,
  const bool *valid_symbols,
  bool *reserved_root_word
) {
  if (
    is_schema_character(lexer->lookahead) ||
    is_bare_value_delimiter(lexer->lookahead)
  ) {
    return false;
  }

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

  if (
    strcmp(prefix, "+PROG") == 0 || strcmp(prefix, "-PROG") == 0 ||
    strcmp(prefix, "+APPLY") == 0 || strcmp(prefix, "-APPLY") == 0 ||
    strcmp(prefix, "+SYS") == 0 || strcmp(prefix, "-SYS") == 0
  ) {
    *reserved_root_word = true;
    return false;
  }

  if (!valid_symbols[BARE_WORD]) {
    return false;
  }

  lexer->mark_end(lexer);
  lexer->result_symbol = BARE_WORD;
  return true;
}

static bool is_global_command(const char *name) {
  for (uint32_t index = 0; index < SOFISTIK_GLOBAL_COMMAND_COUNT; index++) {
    if (strcmp(SOFISTIK_GLOBAL_COMMANDS[index], name) == 0) {
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
  bool *followed_by_hash
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
      lexer->advance(lexer, false);
    }
  }
  lexer->mark_end(lexer);
  return true;
}

static bool scan_word(
  Scanner *scanner,
  TSLexer *lexer,
  const bool *valid_symbols,
  bool *reserved_root_word,
  bool at_line_start,
  bool line_start_known,
  uint32_t skipped_columns
) {
  char word[128] = {0};
  bool contextual = false;
  bool followed_by_hash = false;
  if (!read_word(
        lexer,
        word,
        sizeof(word),
        &contextual,
        &followed_by_hash
      )) {
    return false;
  }
  if (!contextual) {
    if (valid_symbols[BARE_WORD]) {
      lexer->result_symbol = BARE_WORD;
      return true;
    }
    return false;
  }
  if (valid_symbols[END_KEYWORD] &&
      (strcmp(word, "END") == 0 || strcmp(word, "ENDE") == 0)) {
    reset_command(scanner);
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

  bool reserved_root_statement =
    strcmp(word, "PROG") == 0 || strcmp(word, "APPLY") == 0 ||
    strcmp(word, "SYS") == 0;
  if (reserved_root_statement) {
    if (!line_start_known && scanner->command != SOFISTIK_UNKNOWN_ID) {
      at_line_start =
        lexer->get_column(lexer) == skipped_columns + strlen(word);
    }
    if (at_line_start || scanner->command == SOFISTIK_UNKNOWN_ID) {
      *reserved_root_word = true;
      return false;
    }
  }

  if (valid_symbols[IGNORED_TEXT] && is_reserved_statement_word(word)) {
    *reserved_root_word = true;
    return false;
  }

  if (
    (valid_symbols[COMMAND_NAME] || valid_symbols[INVALID_COMMAND]) &&
    !(valid_symbols[BARE_WORD] && valid_symbols[IGNORED_TEXT] &&
      !at_line_start) &&
    !(valid_symbols[IGNORED_TEXT] && scanner->module == SOFISTIK_UNKNOWN_ID)
  ) {
    uint32_t command = find_command(scanner->module, word);
    if (command != SOFISTIK_UNKNOWN_ID && valid_symbols[COMMAND_NAME]) {
      scanner->command = command;
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
      scanner->command == SOFISTIK_UNKNOWN_ID && is_global_command(word)
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

  if (valid_symbols[ITEM_NAME]) {
    uint32_t item = find_item(scanner->command, word);
    if (item != SOFISTIK_UNKNOWN_ID) {
      lexer->result_symbol = ITEM_NAME;
      return true;
    }
  }

  if (valid_symbols[VARIABLE_KEYWORD] && is_variable_keyword(word)) {
    lexer->result_symbol = VARIABLE_KEYWORD;
    return true;
  }

  // A globally known item can still be a legal positional literal here. The
  // grammar deliberately leaves that irreducible ambiguity to the linter.
  (void)valid_symbols[INVALID_ITEM];
  if (
    valid_symbols[BARE_WORD] &&
    !(valid_symbols[COMMAND_NAME] && is_reserved_statement_word(word)) &&
    (!(scanner->command == SOFISTIK_UNKNOWN_ID && valid_symbols[COMMAND_NAME]) ||
     valid_symbols[IGNORED_TEXT])
  ) {
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

    if (could_be_prog && !prog[index] && !is_schema_character(lexer->lookahead)) {
      if (valid_symbols[DOLLAR_PROG]) {
        reset_context(scanner);
        lexer->mark_end(lexer);
        lexer->result_symbol = DOLLAR_PROG;
        return true;
      }
      could_be_prog = false;
    }
    if (could_be_apply && !apply[index] && !is_schema_character(lexer->lookahead)) {
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

static bool is_generator_space(int32_t character) {
  return character == ' ' || character == '\t' || character == '\f';
}

static bool scan_parenthesized_start(
  TSLexer *lexer,
  const bool *valid_symbols
) {
  if (lexer->lookahead != '(') {
    return false;
  }

  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  unsigned component_count = 0;
  unsigned depth = 1;
  bool in_component = false;
  bool generator_candidate = true;
  bool has_embedded_value = false;

  while (lexer->lookahead) {
    if (
      lexer->lookahead == '\r' || lexer->lookahead == '\n' ||
      lexer->lookahead == '!' || lexer->lookahead == ';'
    ) {
      return false;
    }

    if (lexer->lookahead == '#') {
      if (!scan_hash_variable_candidate(lexer)) {
        return false;
      }
      has_embedded_value = true;
      if (depth == 1) {
        in_component = true;
      }
      continue;
    }

    if (lexer->lookahead == '$') {
      if (!scan_dollar_variable_candidate(lexer)) {
        return false;
      }
      has_embedded_value = true;
      if (depth == 1) {
        in_component = true;
      }
      continue;
    }

    if (lexer->lookahead == '\'' || lexer->lookahead == '"') {
      int32_t quote = lexer->lookahead;
      if (!scan_string_candidate(lexer, quote)) {
        return false;
      }
      has_embedded_value = true;
      if (depth == 1) {
        in_component = true;
      }
      continue;
    }

    if (lexer->lookahead == '(') {
      generator_candidate = false;
      depth++;
      lexer->advance(lexer, false);
      continue;
    }

    if (lexer->lookahead == ')') {
      depth--;
      if (depth == 0) {
        if (in_component) {
          component_count++;
        }
        if (
          generator_candidate && component_count >= 2 &&
          valid_symbols[SEQUENCE_GENERATOR_START]
        ) {
          lexer->result_symbol = SEQUENCE_GENERATOR_START;
          return true;
        }
        if (
          has_embedded_value &&
          valid_symbols[PARENTHESIZED_EXPRESSION_START]
        ) {
          lexer->result_symbol = PARENTHESIZED_EXPRESSION_START;
          return true;
        }
        return false;
      }
      lexer->advance(lexer, false);
      continue;
    }

    if (depth == 1 && is_generator_space(lexer->lookahead)) {
      if (in_component) {
        component_count++;
        in_component = false;
      }
      lexer->advance(lexer, false);
      continue;
    }

    if (depth == 1) {
      in_component = true;
    }
    lexer->advance(lexer, false);
  }

  return false;
}

static bool scan_preprocessor_literal(TSLexer *lexer) {
  bool has_content = false;
  while (
    lexer->lookahead && lexer->lookahead != '\r' &&
    lexer->lookahead != '\n' && lexer->lookahead != '!' &&
    lexer->lookahead != '#' && lexer->lookahead != '$' &&
    lexer->lookahead != '\'' && lexer->lookahead != '"'
  ) {
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

  bool needs_line_start = valid_symbols[BARE_WORD] && valid_symbols[IGNORED_TEXT];
  bool at_line_start = needs_line_start && lexer->get_column(lexer) == 0;

  uint32_t skipped_columns = 0;
  while (
    lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
    lexer->lookahead == '\f' || lexer->lookahead == 0x00ef ||
    lexer->lookahead == 0x00bb || lexer->lookahead == 0x00bf
  ) {
    lexer->advance(lexer, true);
    skipped_columns++;
  }

  if (lexer->lookahead == '$') {
    return scan_dollar(scanner, lexer, valid_symbols);
  }

  if (
    (valid_symbols[SEQUENCE_GENERATOR_START] ||
     valid_symbols[PARENTHESIZED_EXPRESSION_START]) &&
    lexer->lookahead == '('
  ) {
    return scan_parenthesized_start(lexer, valid_symbols);
  }

  if (
    valid_symbols[PREPROCESSOR_LITERAL] &&
    scan_preprocessor_literal(lexer)
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
  if (scan_non_word_bare(lexer, valid_symbols, &reserved_root_word)) {
    return true;
  }
  if (scan_word(
        scanner,
        lexer,
        valid_symbols,
        &reserved_root_word,
        at_line_start,
        needs_line_start,
        skipped_columns
      )) {
    return true;
  }
  if (
    valid_symbols[IGNORED_TEXT] && has_ignored_text_start &&
    !reserved_root_word && initial_lookahead != '#' &&
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
  return 9;
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
  if (scanner->text_state > IN_TEXT_BODY) {
    scanner->text_state = OUTSIDE_TEXT;
  }
}

void tree_sitter_sofistik_external_scanner_destroy(void *payload) {
  free(payload);
}
