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
  TEXT_CONTENT,
  END_OF_FILE,
  IGNORED_TEXT,
  PREPROCESSOR_RECOVERY_VALUE,
  ERROR_SENTINEL,
};

enum RecordState {
  BETWEEN_RECORDS,
  IN_RECORD,
  AFTER_ITEM,
};

typedef struct {
  uint32_t module;
  uint32_t command;
  uint32_t item;
  uint8_t record_state;
  bool continued_line;
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

static bool is_reserved_statement_word(const char *word) {
  static const char *const words[] = {
    "DBG", "DEL", "ELSE", "ELSEIF", "ENDIF", "ENDLOOP",
    "EXIT_ITERATION", "IF", "LET", "LOOP", "PRT", "RCL", "STO",
  };
  size_t count = sizeof(words) / sizeof(words[0]);
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
  size_t count = sizeof(words) / sizeof(words[0]);
  for (size_t index = 0; index < count; index++) {
    if (strcmp(words[index], word) == 0) {
      return true;
    }
  }
  return false;
}

static void reset_command(Scanner *scanner) {
  scanner->command = SOFISTIK_UNKNOWN_ID;
  scanner->item = SOFISTIK_UNKNOWN_ID;
  scanner->record_state = BETWEEN_RECORDS;
  scanner->continued_line = false;
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

static uint32_t find_command(uint32_t module, const char *name) {
  if (module >= SOFISTIK_MODULE_COUNT) {
    return SOFISTIK_UNKNOWN_ID;
  }
  const SofistikModuleSchema *schema = &SOFISTIK_MODULES[module];
  for (uint32_t offset = 0; offset < schema->command_count; offset++) {
    uint32_t index = schema->command_start + offset;
    if (strcmp(SOFISTIK_COMMANDS[index].name, name) == 0) {
      return index;
    }
  }
  return SOFISTIK_UNKNOWN_ID;
}

static uint32_t find_item(uint32_t command, const char *name) {
  if (command >= SOFISTIK_COMMAND_COUNT) {
    return SOFISTIK_UNKNOWN_ID;
  }
  const SofistikCommandSchema *schema = &SOFISTIK_COMMANDS[command];
  for (uint32_t offset = 0; offset < schema->item_count; offset++) {
    uint32_t index = schema->item_start + offset;
    if (strcmp(SOFISTIK_ITEMS[index].name, name) == 0) {
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
    !valid_symbols[BARE_WORD] || is_schema_character(lexer->lookahead) ||
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
  bool at_line_start
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

  if (
    (at_line_start || scanner->command == SOFISTIK_UNKNOWN_ID) &&
    (strcmp(word, "PROG") == 0 || strcmp(word, "APPLY") == 0 ||
     strcmp(word, "SYS") == 0)
  ) {
    *reserved_root_word = true;
    return false;
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
      scanner->item = SOFISTIK_UNKNOWN_ID;
      scanner->record_state = IN_RECORD;
      scanner->continued_line = false;
      lexer->result_symbol = COMMAND_NAME;
      return true;
    }
    if (valid_symbols[TEMPLATE_COMMAND_NAME] && is_template_module(scanner->module)) {
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
    lexer->result_symbol = TEMPLATE_COMMAND_NAME;
    return true;
  }

  if (valid_symbols[ITEM_NAME]) {
    uint32_t item = find_item(scanner->command, word);
    if (item != SOFISTIK_UNKNOWN_ID) {
      scanner->item = item;
      scanner->record_state = AFTER_ITEM;
      scanner->continued_line = false;
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
      scanner->continued_line = true;
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
  bool has_variable = false;

  while (lexer->lookahead) {
    if (
      lexer->lookahead == '\r' || lexer->lookahead == '\n' ||
      lexer->lookahead == '!' || lexer->lookahead == ';'
    ) {
      return false;
    }

    if (lexer->lookahead == '#') {
      lexer->advance(lexer, false);
      if (!is_schema_character(lexer->lookahead)) {
        return false;
      }
      while (is_schema_character(lexer->lookahead)) {
        lexer->advance(lexer, false);
      }
      if (lexer->lookahead == '(') {
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
      }
      has_variable = true;
      if (depth == 1) {
        in_component = true;
      }
      continue;
    }

    if (lexer->lookahead == '$') {
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
      has_variable = true;
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
        if (has_variable && valid_symbols[PARENTHESIZED_EXPRESSION_START]) {
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
    lexer->lookahead != '#' && lexer->lookahead != '$'
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

static bool scan_text_content(TSLexer *lexer) {
  bool has_content = false;

  while (lexer->lookahead) {
    if (lexer->lookahead == '<') {
      lexer->mark_end(lexer);
      lexer->advance(lexer, false);
      if (lexer->lookahead == '/') {
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
      continue;
    }

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
  bool at_line_start = lexer->get_column(lexer) == 0;

  // Tree-sitter marks every external token valid during error recovery. The
  // sentinel is never part of a successful production; checking the complete
  // set avoids confusing its ordinary always-valid state with recovery.
  bool all_symbols_valid = valid_symbols[ERROR_SENTINEL];
  for (unsigned index = 0; index < ERROR_SENTINEL; index++) {
    all_symbols_valid = all_symbols_valid && valid_symbols[index];
  }
  if (all_symbols_valid) {
    if (
      valid_symbols[PREPROCESSOR_RECOVERY_VALUE] &&
      scan_preprocessor_recovery_value(lexer)
    ) {
      return true;
    }
    return false;
  }

  if (valid_symbols[TEXT_CONTENT]) {
    return scan_text_content(lexer);
  }

  if (valid_symbols[END_OF_FILE] && !lexer->lookahead) {
    lexer->result_symbol = END_OF_FILE;
    return true;
  }

  while (
    lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
    lexer->lookahead == '\f' || lexer->lookahead == 0x00ef ||
    lexer->lookahead == 0x00bb || lexer->lookahead == 0x00bf
  ) {
    lexer->advance(lexer, true);
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
        at_line_start
      )) {
    return true;
  }
  if (
    valid_symbols[IGNORED_TEXT] && has_ignored_text_start &&
    !reserved_root_word && initial_lookahead != '#' &&
    initial_lookahead != '<' && initial_lookahead != '@' &&
    initial_lookahead != '+' && initial_lookahead != '-'
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
  write_u32(buffer + 8, scanner->item);
  buffer[12] = (char)scanner->record_state;
  buffer[13] = scanner->continued_line ? 1 : 0;
  return 14;
}

void tree_sitter_sofistik_external_scanner_deserialize(
  void *payload,
  const char *buffer,
  unsigned length
) {
  Scanner *scanner = payload;
  reset_context(scanner);
  if (length < 14) {
    return;
  }
  scanner->module = read_u32(buffer);
  scanner->command = read_u32(buffer + 4);
  scanner->item = read_u32(buffer + 8);
  scanner->record_state = (uint8_t)buffer[12];
  scanner->continued_line = buffer[13] != 0;
}

void tree_sitter_sofistik_external_scanner_destroy(void *payload) {
  free(payload);
}
