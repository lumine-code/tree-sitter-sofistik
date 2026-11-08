const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const test = require("node:test");
const {
  cliVersion,
  toolchains,
  downloadArchive,
  withToolchains,
  removeTemporary,
} = require("./wasm-toolchains");

const bytes = Buffer.from("verified official tar bytes");
const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fixtureToken = "fixture-token-not-a-credential";

function asset(tool) {
  return {
    id: 123,
    name: tool.filename,
    size: bytes.length,
    digest,
    browser_download_url: `https://github.com/${tool.repository}/releases/download/${tool.tag}/${tool.filename}`,
  };
}

function fixtureFetch(tool, change = () => {}) {
  const metadata = { tag_name: tool.tag, assets: [asset(tool)] };
  change(metadata);
  return async (url) =>
    url.includes("/tags/")
      ? { ok: true, json: async () => metadata }
      : { ok: true, status: 200, body: Readable.from([bytes]) };
}

function temporary(t) {
  const base = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, "wasm-toolchains-test-"));
  t.after(() => {
    assert.equal(path.dirname(root), base);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("recursive cleanup refuses a junction or an unrelated directory and preserves its bytes", (t) => {
  const parent = temporary(t);
  const outside = temporary(t);
  const sentinel = path.join(outside, "preserved.txt");
  fs.writeFileSync(sentinel, "unrelated bytes");
  const link = path.join(parent, "wasm-toolchains-redirected");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => removeTemporary(link, parent), /canonical build scope/);
  assert.throws(() => removeTemporary(outside, parent), /canonical build scope/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unrelated bytes");
  fs.unlinkSync(link);
});

test("tool versions stay coupled to the exact pinned CLI", () => {
  assert.equal(cliVersion, require("../package.json").devDependencies["tree-sitter-cli"]);
  assert.equal(toolchains("win32", "x64")[0].filename, "wasi-sdk-34.0-x86_64-windows.tar.gz");
  assert.equal(
    toolchains("win32", "x64")[1].filename,
    "binaryen-version_132-x86_64-windows.tar.gz",
  );
});

for (const [platform, arch, sdk, binaryen] of [
  ["linux", "x64", "x86_64-linux", "x86_64-linux"],
  ["linux", "arm64", "arm64-linux", "aarch64-linux"],
  ["darwin", "x64", "x86_64-macos", "x86_64-macos"],
  ["darwin", "arm64", "arm64-macos", "arm64-macos"],
  ["win32", "arm64", "arm64-windows", "arm64-windows"],
]) {
  test(`official CLI platform mapping ${platform}/${arch}`, () => {
    const tools = toolchains(platform, arch);
    assert.equal(tools[0].filename, `wasi-sdk-34.0-${sdk}.tar.gz`);
    assert.equal(tools[1].filename, `binaryen-version_132-${binaryen}.tar.gz`);
  });
}

test("unsupported platforms fail before attempting a download", () => {
  assert.throws(() => toolchains("freebsd", "x64"), /Unsupported/);
  assert.throws(() => toolchains("linux", "ia32"), /Unsupported/);
});

test("streams verified bytes into an exclusive archive without credentials", async (t) => {
  const tool = toolchains("win32", "x64")[1];
  const output = path.join(temporary(t), "tool.tar.gz");
  const calls = [];
  const fetch = fixtureFetch(tool);
  await downloadArchive(tool, output, (url, options) => {
    calls.push({ url, options });
    return fetch(url, options);
  });
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[1].options.redirect, "manual");
  assert.equal(calls[1].options.headers.Authorization, undefined);
});

for (const host of ["release-assets.githubusercontent.com", "objects.githubusercontent.com"]) {
  test(`API credentials are stripped before an official ${host} redirect`, async (t) => {
    const tool = toolchains("win32", "x64")[1];
    const calls = [];
    const fetch = fixtureFetch(tool);
    await downloadArchive(
      tool,
      path.join(temporary(t), "tool.tar.gz"),
      async (url, options) => {
        calls.push({ url, options });
        if (url.includes("/assets/")) {
          return { status: 302, headers: new Map([["location", `https://${host}/asset`]]) };
        }
        return fetch(url, options);
      },
      fixtureToken,
    );
    assert.equal(calls.length, 3);
    for (const call of calls.slice(0, 2)) {
      assert.equal(new URL(call.url).hostname, "api.github.com");
      assert.equal(call.options.headers.Authorization, `Bearer ${fixtureToken}`);
    }
    assert.equal(calls[2].options.headers, undefined);
    assert.equal(JSON.stringify(calls[2]).includes(fixtureToken), false);
  });
}

for (const target of [
  "http://release-assets.githubusercontent.com/asset",
  "https://untrusted.example/asset",
  "https://api.github.com/other",
  "https://secret@release-assets.githubusercontent.com/asset",
  "https://release-assets.githubusercontent.com:8443/asset",
]) {
  test(`rejects unexpected credential-bearing redirect boundary: ${target}`, async (t) => {
    const tool = toolchains("linux", "x64")[1];
    const fetch = fixtureFetch(tool);
    await assert.rejects(
      downloadArchive(
        tool,
        path.join(temporary(t), "tool.tar.gz"),
        async (url, options) =>
          url.includes("/assets/")
            ? { status: 302, headers: new Map([["location", target]]) }
            : fetch(url, options),
        fixtureToken,
      ),
      /outside the allowed/,
    );
  });
}

for (const [label, change] of [
  ["wrong tag", (release) => (release.tag_name = "version_133")],
  ["different official URL", (release) => (release.assets[0].browser_download_url += "/other")],
  ["duplicate assets", (release) => release.assets.push(release.assets[0])],
  ["missing digest", (release) => delete release.assets[0].digest],
  ["oversized archive", (release) => (release.assets[0].size = 2 ** 31)],
  ["invalid asset id", (release) => (release.assets[0].id = -1)],
  ["wrong digest", (release) => (release.assets[0].digest = `sha256:${"0".repeat(64)}`)],
  ["truncated stream", (release) => release.assets[0].size++],
  ["oversized stream", (release) => release.assets[0].size--],
]) {
  test(`never extracts or builds with ${label}`, async (t) => {
    const root = temporary(t);
    const tool = toolchains("win32", "x64")[0];
    let extracted = false;
    let built = false;
    await assert.rejects(
      withToolchains(root, () => (built = true), {
        env: {},
        platform: "win32",
        arch: "x64",
        fetch: fixtureFetch(tool, change),
        run: () => (extracted = true),
      }),
    );
    assert.equal(extracted, false);
    assert.equal(built, false);
    assert.deepEqual(fs.readdirSync(path.join(root, "build")), []);
  });
}

for (const [phase, status] of [
  ["metadata", 403],
  ["metadata", 404],
  ["asset", 504],
]) {
  test(`propagates ${phase} HTTP ${status} without extracting`, async (t) => {
    const tool = toolchains("linux", "x64")[0];
    const fetch = fixtureFetch(tool);
    await assert.rejects(
      downloadArchive(tool, path.join(temporary(t), "archive"), async (url, options) =>
        url.includes(phase === "metadata" ? "/tags/" : "/assets/")
          ? { ok: false, status }
          : fetch(url, options),
      ),
      new RegExp(`HTTP ${status}`),
    );
  });
}

test("body stream errors propagate and close the archive file", async (t) => {
  const tool = toolchains("linux", "x64")[0];
  const root = temporary(t);
  const output = path.join(root, "archive");
  const fetch = fixtureFetch(tool);
  await assert.rejects(
    downloadArchive(tool, output, async (url, options) =>
      url.includes("/assets/")
        ? {
            ok: true,
            status: 200,
            body: Readable.from(
              (async function* () {
                yield bytes.subarray(0, 1);
                throw new Error("stream interrupted");
              })(),
            ),
          }
        : fetch(url, options),
    ),
    /stream interrupted/,
  );
  fs.unlinkSync(output);
});

for (const key of ["HTTPS_PROXY", "https_proxy"]) {
  test(`explicit ${key} retains the upstream proxy transport`, async (t) => {
    const env = { [key]: "https://proxy.example", GITHUB_TOKEN: fixtureToken };
    const root = temporary(t);
    const result = await withToolchains(root, (actual) => actual, {
      env,
      fetch: () => assert.fail("proxy must not be bypassed"),
    });
    assert.deepEqual(result, env);
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

test("explicit toolchain roots are preserved without network access", async (t) => {
  const env = {
    TREE_SITTER_WASI_SDK_PATH: "explicit sdk",
    TREE_SITTER_BINARYEN_PATH: "explicit bin",
  };
  const result = await withToolchains(temporary(t), (actual) => actual, {
    env,
    fetch: () => assert.fail("explicit paths must not be replaced"),
  });
  assert.deepEqual(result, env);
});

for (const fail of [false, true]) {
  test(`passes a verified missing tool root to the build and cleans it; build fails=${fail}`, async (t) => {
    const root = temporary(t);
    const tool = toolchains("win32", "x64")[1];
    const env = { TREE_SITTER_WASI_SDK_PATH: "explicit sdk", GITHUB_TOKEN: fixtureToken };
    let directory;
    const invocation = withToolchains(
      root,
      (actual) => {
        assert.equal(actual.TREE_SITTER_WASI_SDK_PATH, "explicit sdk");
        directory = actual.TREE_SITTER_BINARYEN_PATH;
        assert.equal(fs.existsSync(path.join(directory, "bin", "wasm-opt.exe")), true);
        if (fail) throw new Error("actual compiler failed");
        return 42;
      },
      {
        env,
        platform: "win32",
        arch: "x64",
        fetch: fixtureFetch(tool),
        run: (command, args) => {
          assert.equal(command, "tar");
          assert.equal(args[2], "--strip-components=1");
          fs.mkdirSync(path.join(args[4], "bin"));
          fs.writeFileSync(path.join(args[4], "bin", "wasm-opt.exe"), "fixture executable");
          return { status: 0 };
        },
      },
    );
    if (fail) await assert.rejects(invocation, /actual compiler failed/);
    else assert.equal(await invocation, 42);
    assert.equal(fs.existsSync(directory), false);
    assert.equal(env.TREE_SITTER_BINARYEN_PATH, undefined);
    assert.deepEqual(fs.readdirSync(path.join(root, "build")), []);
  });
}

for (const result of [{ status: 1 }, { error: new Error("tar unavailable") }, { status: 0 }]) {
  test(`tar failure or missing executable prevents the build: ${JSON.stringify(result)}`, async (t) => {
    const root = temporary(t);
    const tool = toolchains("win32", "x64")[0];
    await assert.rejects(
      withToolchains(root, () => assert.fail("must not build"), {
        env: {},
        platform: "win32",
        arch: "x64",
        fetch: fixtureFetch(tool),
        run: () => result,
      }),
    );
    assert.deepEqual(fs.readdirSync(path.join(root, "build")), []);
  });
}
