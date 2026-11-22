import { zipSync, strToU8 } from "fflate";
import instructions from "./安装说明.txt";

const releases = "https://github.com/Aurxs/BilibiliLiveDelay/releases";
const downloadPath = "/BilibiliLiveDelay.zip";

async function refreshPackage(env) {
  const latest = await fetch(releases + "/latest", {
    method: "HEAD",
    redirect: "manual",
    headers: { "User-Agent": "BilibiliLiveDelay-Pages" },
  });
  const location = latest.headers.get("Location");
  const tagPrefix = releases + "/tag/";
  if (!location?.startsWith(tagPrefix)) throw new Error("Missing latest release");
  const tag = location.slice(tagPrefix.length);
  if (!/^v\d+(\.\d+){1,3}$/.test(tag)) throw new Error("Invalid release tag");

  const stem = "BilibiliLiveDelay-" + tag;
  const base = releases + "/download/" + tag + "/";
  const sums = await fetch(base + "SHA256SUMS");
  if (!sums.ok) throw new Error("Missing release checksums");
  const checksums = new Map((await sums.text()).trim().split(/\r?\n/).map(line => {
    const [checksum, file] = line.trim().split(/\s+/);
    return [file, checksum];
  }));
  const files = await Promise.all([".crx", ".zip"].map(async extension => {
    const name = stem + extension;
    const asset = await fetch(base + name);
    if (!asset.ok) throw new Error("Missing release asset: " + name);
    const data = new Uint8Array(await asset.arrayBuffer());
    if (await sha256(data) !== checksums.get(name)) throw new Error("Checksum mismatch: " + name);
    return [name, data];
  }));
  const contents = Object.fromEntries(files);
  contents["安装说明.txt"] = strToU8("\uFEFF" + instructions.replace(/\r?\n/g, "\r\n"));
  const bytes = zipSync(contents, { level: 0, mtime: new Date(2000, 0, 1) });
  const filename = stem + "-bundle.zip";
  const digest = await sha256(bytes);
  await env.RELEASES.put("latest", bytes, { metadata: { tag, filename, digest, size: bytes.byteLength } });
  return tag;
}

async function sha256(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function handleWebhook(request, env) {
  const signature = request.headers.get("X-Hub-Signature-256") || "";
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return new Response(null, { status: 401 });
  const body = await request.arrayBuffer();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const mac = Uint8Array.from(signature.slice(7).match(/../g), pair => parseInt(pair, 16));
  if (!await crypto.subtle.verify("HMAC", key, mac, body)) return new Response(null, { status: 401 });
  const payload = JSON.parse(new TextDecoder().decode(body));
  const event = request.headers.get("X-GitHub-Event");
  if (payload.repository?.id !== 1413979318 || !["release", "ping"].includes(event)) {
    return new Response(null, { status: 204 });
  }
  return new Response(await refreshPackage(env));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/hooks/github" && request.method === "POST") return handleWebhook(request, env);
    if (url.pathname !== downloadPath && url.pathname !== "/") return new Response("Not found", { status: 404 });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

    const cacheKey = new Request(new URL("/cached/release-bundle", url.origin));
    let response = await caches.default.match(cacheKey);
    if (!response) {
      const { value, metadata } = await env.RELEASES.getWithMetadata("latest", "arrayBuffer");
      if (!value) return new Response("Release unavailable", { status: 503, headers: { "Cache-Control": "no-store" } });
      response = new Response(value, { headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="' + metadata.filename + '"',
        "Cache-Control": "public, max-age=120",
        "Content-Length": String(metadata.size),
        "X-Release-Tag": metadata.tag,
        ETag: '"' + metadata.digest + '"',
      } });
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(request.method === "HEAD" ? null : response.body, { headers });
  },
};
