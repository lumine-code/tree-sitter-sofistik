#include <napi.h>

typedef struct TSLanguage TSLanguage;

extern "C" TSLanguage *tree_sitter_sofistik();
extern "C" TSLanguage *tree_sitter_sofistik_def();

// "tree-sitter", "language" hashed with BLAKE2.
const napi_type_tag LANGUAGE_TYPE_TAG = {
  0x8AF2E5212AD58ABF,
  0xD5006CAD83ABBA16,
};

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports["name"] = Napi::String::New(env, "sofistik");
  auto language = Napi::External<TSLanguage>::New(env, tree_sitter_sofistik());
  language.TypeTag(&LANGUAGE_TYPE_TAG);
  exports["language"] = language;
  auto definition = Napi::Object::New(env);
  definition["name"] = Napi::String::New(env, "sofistik_def");
  auto definitionLanguage =
      Napi::External<TSLanguage>::New(env, tree_sitter_sofistik_def());
  definitionLanguage.TypeTag(&LANGUAGE_TYPE_TAG);
  definition["language"] = definitionLanguage;
  exports["def"] = definition;
  return exports;
}

NODE_API_MODULE(tree_sitter_sofistik_binding, Init)

