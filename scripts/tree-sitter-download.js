const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { createHash } = require("node:crypto");
const { Readable } = require("node:stream");

const releaseAPI = "https://api.github.com/repos/tree-sitter/tree-sitter/releases";
const maxArchiveBytes = 64 * 1024 * 1024;

async function releaseBytes(url, fetch) {
  const [, tag, filename] =
    /^https:\/\/github\.com\/tree-sitter\/tree-sitter\/releases\/download\/([^/?#]+)\/(tree-sitter-[a-z0-9-]+\.gz)$/.exec(
      url,
    );
  const signal = AbortSignal.timeout(120000);
  const metadata = await fetch(`${releaseAPI}/tags/${tag}`, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!metadata.ok) throw new Error(`Tree-sitter release API returned HTTP ${metadata.status}`);
  const release = await metadata.json();
  const assets = release.assets?.filter(
    (asset) => asset.name === filename && asset.browser_download_url === url,
  );
  if (release.tag_name !== tag || assets?.length !== 1) {
    throw new Error("The official Tree-sitter release does not identify the requested asset");
  }
  const asset = assets[0];
  if (
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > maxArchiveBytes ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
  ) {
    throw new Error("The official Tree-sitter asset lacks a valid size, identifier or SHA-256");
  }
  const response = await fetch(`${releaseAPI}/assets/${asset.id}`, {
    headers: { Accept: "application/octet-stream" },
    signal,
  });
  if (!response.ok) throw new Error(`Tree-sitter asset API returned HTTP ${response.status}`);
  const chunks = [];
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > asset.size) {
      throw new Error("The Tree-sitter release asset exceeds its declared size");
    }
    chunks.push(chunk);
    hash.update(chunk);
  }
  if (size !== asset.size || `sha256:${hash.digest("hex")}` !== asset.digest) {
    throw new Error("The Tree-sitter release asset does not match its published SHA-256 and size");
  }
  return Buffer.concat(chunks);
}

function downloadTransport(get, fetch, version, report = console.error) {
  return function download(...args) {
    const [input, callback] = args;
    const url =
      typeof input === "string" ? input : input?.host ? `https://${input.host}${input.path}` : "";
    const match =
      /^https:\/\/github\.com\/tree-sitter\/tree-sitter\/releases\/download\/([^/?#]+)\/(tree-sitter-[a-z0-9-]+\.gz)$/.exec(
        url,
      );
    // The npm CLI installer uses just (URL, callback). All other callers keep
    // the original https API.
    if (args.length !== 2 || typeof callback !== "function" || match?.[1] !== `v${version}`) {
      return get(...args);
    }
    return get(input, (response) => {
      if (![408, 429].includes(response.statusCode) && response.statusCode < 500) {
        callback(response);
        return;
      }
      response.resume();
      report(`Downloading ${match[2]} through the official GitHub release asset API.`);
      releaseBytes(url, fetch).then(
        (bytes) => {
          const verified = Readable.from([bytes]);
          verified.statusCode = 200;
          verified.headers = { "content-length": String(bytes.length) };
          callback(verified);
        },
        (error) => {
          report(error.message);
          const failure = Readable.from([]);
          failure.statusCode = 502;
          failure.headers = {};
          callback(failure);
        },
      );
    });
  };
}

// NODE_OPTIONS preloads this file only for the npm-ci step. Activate solely in
// the pinned upstream CLI's lifecycle child, before its unchanged installer
// selects the platform, decompresses the gzip and writes its executable.
const entry = process.argv[1];
if (
  entry &&
  path.basename(entry) === "install.js" &&
  path.basename(path.dirname(entry)) === "tree-sitter-cli"
) {
  const cli = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"));
  const pin = require("../package.json").devDependencies["tree-sitter-cli"];
  // Keep an explicitly configured HTTPS proxy under the upstream installer's
  // control; a fetch fallback must not silently bypass that network setting.
  if (
    cli.name === "tree-sitter-cli" &&
    cli.version === pin &&
    !process.env.HTTPS_PROXY &&
    !process.env.https_proxy
  ) {
    https.get = downloadTransport(https.get, globalThis.fetch, pin);
  }
}

module.exports = { downloadTransport, releaseBytes };
