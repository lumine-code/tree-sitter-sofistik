function apiHeaders(url, accept, token) {
  const target = new URL(url);
  if (
    target.origin !== "https://api.github.com" ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error("Release API requests must use literal https://api.github.com endpoints");
  }
  const headers = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function releaseMetadata(url, fetch, signal, token) {
  return fetch(url, {
    headers: apiHeaders(url, "application/vnd.github+json", token),
    signal,
    redirect: "error",
  });
}

async function releaseAsset(url, fetch, signal, token) {
  let response = await fetch(url, {
    headers: apiHeaders(url, "application/octet-stream", token),
    signal,
    redirect: "manual",
  });
  for (let count = 0; [301, 302, 303, 307, 308].includes(response.status); count++) {
    await response.body?.cancel();
    if (count === 3) throw new Error("Official release asset redirected too many times");
    const target = new URL(response.headers.get("location"), url);
    if (
      target.protocol !== "https:" ||
      target.port ||
      target.username ||
      target.password ||
      !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
        target.hostname,
      )
    ) {
      throw new Error("Official release asset redirected outside the allowed HTTPS asset hosts");
    }
    url = target.href;
    // Never forward API credentials or caller headers to the signed asset URL.
    response = await fetch(url, { signal, redirect: "manual" });
  }
  return response;
}

module.exports = { releaseMetadata, releaseAsset };
