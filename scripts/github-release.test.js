const assert = require("node:assert/strict");
const test = require("node:test");
const { releaseMetadata, releaseAsset } = require("./github-release");

const token = "fixture-token-not-a-credential";
const api = "https://api.github.com/repos/WebAssembly/binaryen/releases/assets/123";

for (const url of [
  "https://untrusted.example/asset",
  "http://api.github.com/asset",
  "https://api.github.com.evil.example/asset",
  "https://user@api.github.com/asset",
  "https://api.github.com:8443/asset",
  "https://api.github.com/asset#fragment",
]) {
  test(`never sends a fixture credential to a non-API boundary: ${url}`, async () => {
    const fetch = () => assert.fail("no request may escape the API boundary");
    assert.throws(() => releaseMetadata(url, fetch, undefined, token), /literal/);
    await assert.rejects(releaseAsset(url, fetch, undefined, token), /literal/);
  });
}

test("metadata authentication is explicit and redirects cannot forward it", async () => {
  const calls = [];
  const fetch = (url, options) => {
    calls.push({ url, options });
    return "response";
  };
  assert.equal(releaseMetadata(api, fetch, undefined), "response");
  assert.equal(releaseMetadata(api, fetch, undefined, token), "response");
  assert.deepEqual(calls[0].options.headers, { Accept: "application/vnd.github+json" });
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[1].options.redirect, "error");
});

test("all redirect bodies are cancelled and the redirect budget is finite", async () => {
  let cancelled = 0;
  const calls = [];
  await assert.rejects(
    releaseAsset(
      api,
      async (url, options) => {
        calls.push({ url, options });
        return {
          status: 302,
          headers: new Map([["location", "https://release-assets.githubusercontent.com/asset"]]),
          body: { cancel: async () => cancelled++ },
        };
      },
      undefined,
      token,
    ),
    /too many/,
  );
  assert.equal(calls.length, 4);
  assert.equal(cancelled, 4);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  for (const call of calls.slice(1)) assert.equal(call.options.headers, undefined);
});
