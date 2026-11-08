const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { releaseMetadata, releaseAsset } = require("./github-release");

// Keep these in step with crates/loader/{wasi-sdk,binaryen}-version in the
// pinned Tree-sitter CLI. Its documented overrides name a root containing bin/.
const cliVersion = "0.27.2";

function removeTemporary(directory, parent) {
  if (
    !path.isAbsolute(parent) ||
    path.dirname(directory) !== parent ||
    !path.basename(directory).startsWith("wasm-toolchains-") ||
    fs.realpathSync.native(parent) !== parent ||
    fs.lstatSync(directory).isSymbolicLink() ||
    fs.realpathSync.native(directory) !== directory
  ) {
    throw new Error(
      "Refusing to remove a WASM toolchain directory outside its canonical build scope",
    );
  }
  fs.rmSync(directory, { recursive: true, force: true });
}

function toolchains(platform, arch) {
  const os = { linux: "linux", darwin: "macos", win32: "windows" }[platform];
  const cpu = { x64: "x86_64", arm64: "arm64" }[arch];
  if (!os || !cpu) throw new Error(`Unsupported WASM toolchain platform: ${platform}/${arch}`);
  const suffix = platform === "win32" ? ".exe" : "";
  return [
    {
      repository: "WebAssembly/wasi-sdk",
      tag: "wasi-sdk-34",
      filename: `wasi-sdk-34.0-${cpu}-${os}.tar.gz`,
      variable: "TREE_SITTER_WASI_SDK_PATH",
      executable: `clang${suffix}`,
      maxBytes: 1024 * 1024 * 1024,
    },
    {
      repository: "WebAssembly/binaryen",
      tag: "version_132",
      filename: `binaryen-version_132-${platform === "linux" && arch === "arm64" ? "aarch64" : cpu}-${os}.tar.gz`,
      variable: "TREE_SITTER_BINARYEN_PATH",
      executable: `wasm-opt${suffix}`,
      maxBytes: 256 * 1024 * 1024,
    },
  ];
}

async function downloadArchive(tool, destination, fetch, token) {
  const api = `https://api.github.com/repos/${tool.repository}/releases`;
  const url = `https://github.com/${tool.repository}/releases/download/${tool.tag}/${tool.filename}`;
  const signal = AbortSignal.timeout(600000);
  const metadata = await releaseMetadata(`${api}/tags/${tool.tag}`, fetch, signal, token);
  if (!metadata.ok) {
    await metadata.body?.cancel();
    throw new Error(`${tool.filename}: release API HTTP ${metadata.status}`);
  }
  const release = await metadata.json();
  const assets = release.assets?.filter(
    (asset) => asset.name === tool.filename && asset.browser_download_url === url,
  );
  if (release.tag_name !== tool.tag || assets?.length !== 1) {
    throw new Error(`${tool.filename}: official release does not identify the exact asset`);
  }
  const asset = assets[0];
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > tool.maxBytes ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
  ) {
    throw new Error(`${tool.filename}: invalid official asset identifier, size or SHA-256`);
  }
  const response = await releaseAsset(`${api}/assets/${asset.id}`, fetch, signal, token);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${tool.filename}: asset API HTTP ${response.status}`);
  }
  const file = await fs.promises.open(destination, "wx");
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > asset.size) throw new Error(`${tool.filename}: asset exceeds declared size`);
      hash.update(chunk);
      await file.writeFile(chunk);
    }
  } finally {
    await file.close();
  }
  const digest = `sha256:${hash.digest("hex")}`;
  if (size !== asset.size || digest !== asset.digest) {
    throw new Error(`${tool.filename}: asset does not match its published SHA-256 and size`);
  }
  console.log(`Verified ${tool.filename}: ${size} bytes, ${digest}`);
}

async function withToolchains(
  root,
  build,
  {
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    fetch = globalThis.fetch,
    run = spawnSync,
  } = {},
) {
  const prepared = { ...env };
  // Preserve explicit tool paths and the upstream curl proxy configuration.
  // Node fetch must not silently bypass a user-configured HTTPS proxy.
  if (env.HTTPS_PROXY || env.https_proxy) return build(prepared);
  const missing = toolchains(platform, arch).filter((tool) => !env[tool.variable]);
  if (!missing.length) return build(prepared);
  const parent = path.join(fs.realpathSync.native(root), "build");
  fs.mkdirSync(parent, { recursive: true });
  if (fs.realpathSync.native(parent) !== parent) {
    throw new Error("Refusing a redirected WASM toolchain build directory");
  }
  const temporary = fs.mkdtempSync(path.join(parent, "wasm-toolchains-"));
  try {
    for (const tool of missing) {
      const archive = path.join(temporary, tool.filename);
      await downloadArchive(tool, archive, fetch, env.GITHUB_TOKEN);
      const directory = path.join(temporary, tool.variable);
      fs.mkdirSync(directory);
      const result = run("tar", ["-xzf", archive, "--strip-components=1", "-C", directory], {
        env: prepared,
        stdio: "inherit",
        windowsHide: true,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`${tool.filename}: tar exited ${result.status}`);
      if (!fs.existsSync(path.join(directory, "bin", tool.executable))) {
        throw new Error(`${tool.filename}: archive lacks bin/${tool.executable}`);
      }
      prepared[tool.variable] = directory;
    }
    return await build(prepared);
  } finally {
    removeTemporary(temporary, parent);
  }
}

module.exports = { cliVersion, toolchains, downloadArchive, withToolchains, removeTemporary };
