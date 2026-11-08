const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { downloadTransport } = require("./tree-sitter-download");

test("the workflow preload path survives Node option parsing, including spaces and Windows separators", () => {
  const temporaryBase = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryBase, "tree-sitter preload "));
  try {
    const preload = path.join(directory, "tree-sitter-download.js");
    fs.copyFileSync(path.join(__dirname, "tree-sitter-download.js"), preload);
    fs.copyFileSync(
      path.join(__dirname, "github-release.js"),
      path.join(directory, "github-release.js"),
    );
    const env = {
      ...process.env,
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      PRELOAD: preload,
    };
    for (const key of Object.keys(env)) if (key.toUpperCase() === "CI") delete env[key];
    const result = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(String(Boolean(require.cache[process.env.PRELOAD])))"],
      { env, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "true");
  } finally {
    assert.equal(path.dirname(directory), temporaryBase);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const proxy of [false, true]) {
  test(`only the pinned CLI lifecycle child opts into the transport; configured proxy=${proxy}`, () => {
    const temporaryBase = fs.realpathSync.native(os.tmpdir());
    const directory = fs.mkdtempSync(path.join(temporaryBase, "tree-sitter install "));
    try {
      const cli = path.join(directory, "node_modules", "tree-sitter-cli");
      fs.mkdirSync(cli, { recursive: true });
      fs.writeFileSync(
        path.join(cli, "package.json"),
        JSON.stringify({
          name: "tree-sitter-cli",
          version: require("../package.json").devDependencies["tree-sitter-cli"],
        }),
      );
      fs.writeFileSync(
        path.join(cli, "install.js"),
        'process.stdout.write(require("node:https").get.name);',
      );
      const env = {
        ...process.env,
        NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, "tree-sitter-download.js"))}`,
      };
      for (const key of Object.keys(env))
        if (["CI", "HTTPS_PROXY"].includes(key.toUpperCase())) delete env[key];
      if (proxy) env.HTTPS_PROXY = "https://proxy.example";
      const result = spawnSync(process.execPath, [path.join(cli, "install.js")], {
        env,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, proxy ? "get" : "download");
    } finally {
      assert.equal(path.dirname(directory), temporaryBase);
      assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
      assert.equal(fs.realpathSync.native(directory), directory);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

const url =
  "https://github.com/tree-sitter/tree-sitter/releases/download/v0.27.2/tree-sitter-windows-x64.gz";
const archive = Buffer.from("compressed release bytes");
const asset = {
  id: 123,
  name: "tree-sitter-windows-x64.gz",
  browser_download_url: url,
  size: archive.length,
  digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
};

function fixture(
  status,
  metadata = { tag_name: "v0.27.2", assets: [asset] },
  bytes = archive,
  token,
) {
  const original = Readable.from([]);
  original.statusCode = status;
  const request = {};
  const calls = [];
  const messages = [];
  const get = downloadTransport(
    (input, callback) => {
      calls.push({ original: input });
      callback(original);
      return request;
    },
    async (input, options) => {
      calls.push({ url: input, options });
      return calls.length === 2 ? Response.json(metadata) : new Response(bytes);
    },
    "0.27.2",
    (message) => messages.push(message),
    token,
  );
  return { get, original, request, calls, messages };
}

test("the lifecycle transport passes an explicitly supplied fixture token only to the API", async () => {
  const token = "fixture-token-not-a-credential";
  const f = fixture(504, undefined, undefined, token);
  const response = await new Promise((resolve) => f.get(url, resolve));
  assert.equal(response.statusCode, 200);
  for (const call of f.calls.slice(1)) {
    assert.equal(new URL(call.url).hostname, "api.github.com");
    assert.equal(call.options.headers.Authorization, `Bearer ${token}`);
  }
  assert.equal(f.calls[1].options.redirect, "error");
  assert.equal(f.calls[2].options.redirect, "manual");
  assert.equal(
    f.messages.some((message) => message.includes(token)),
    false,
  );
});

for (const status of [408, 429, 500, 504, 599]) {
  test(`official HTTP ${status} uses the same asset and verifies its digest`, async () => {
    const f = fixture(status);
    let request;
    const response = await new Promise((resolve) => {
      request = f.get(url, resolve);
    });
    assert.equal(request, f.request);
    assert.equal(response.statusCode, 200);
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), archive);
    assert.equal(
      f.calls[1].url,
      "https://api.github.com/repos/tree-sitter/tree-sitter/releases/tags/v0.27.2",
    );
    assert.equal(
      f.calls[2].url,
      "https://api.github.com/repos/tree-sitter/tree-sitter/releases/assets/123",
    );
    assert.deepEqual(f.calls[1].options.headers, { Accept: "application/vnd.github+json" });
    assert.deepEqual(f.calls[2].options.headers, { Accept: "application/octet-stream" });
    assert.equal(f.calls[1].options.signal, f.calls[2].options.signal);
    assert.equal(f.messages.length, 1);
  });
}

for (const status of [200, 302, 403, 404]) {
  test(`HTTP ${status} stays with the unchanged upstream installer`, async () => {
    const f = fixture(status);
    const response = await new Promise((resolve) => f.get(url, resolve));
    assert.equal(response, f.original);
    assert.equal(f.calls.length, 1);
  });
}

for (const other of [
  url.replace("v0.27.2", "v0.27.1"),
  url.replace("github.com", "mirror.example"),
  url.replace("tree-sitter/tree-sitter", "other/tree-sitter"),
]) {
  test(`unmatched URL passes through: ${other}`, async () => {
    const f = fixture(504);
    assert.equal(await new Promise((resolve) => f.get(other, resolve)), f.original);
    assert.equal(f.calls.length, 1);
  });
}

test("the upstream proxy options branch selects exactly the same asset", async () => {
  const f = fixture(504);
  const response = await new Promise((resolve) =>
    f.get({ host: "github.com", path: new URL(url).pathname, agent: {} }, resolve),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(f.calls.length, 3);
});

for (const altered of [
  { tag_name: "v0.27.1", assets: [asset] },
  { tag_name: "v0.27.2", assets: [] },
  { tag_name: "v0.27.2", assets: [asset, asset] },
  ...[
    { browser_download_url: "https://other/" },
    { id: "123" },
    { size: 100 * 1024 * 1024 },
    { digest: "sha256:unavailable" },
    { digest: `sha256:${"0".repeat(64)}` },
    { size: archive.length - 1 },
    { size: archive.length + 1 },
  ].map((changes) => ({ tag_name: "v0.27.2", assets: [{ ...asset, ...changes }] })),
]) {
  test(`unverified bytes fail the upstream install: ${JSON.stringify(altered)}`, async () => {
    const f = fixture(504, altered);
    const response = await new Promise((resolve) => f.get(url, resolve));
    assert.equal(response.statusCode, 502);
    assert.equal(f.messages.length, 2);
    assert.match(f.messages[1], /Tree-sitter/);
  });
}
