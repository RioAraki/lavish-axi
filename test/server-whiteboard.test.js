import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  createWhiteboardChannelToken,
  createWhiteboardFrameHtml,
  isValidWhiteboardChannelToken,
  serve,
} from "../src/server.js";
import { mermaidSourceHash } from "../src/mermaid-source.js";

const ARTIFACT_HTML = `<!doctype html><html><body>
<h1>Demo</h1>
<pre class="mermaid">flowchart TD
  A[Start] --&gt; B{Ready?}</pre>
<pre class="mermaid">sequenceDiagram
  CLI-&gt;&gt;Server: render</pre>
</body></html>`;

async function startWhiteboardServer() {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-wb-server-"));
  const assetsDir = path.join(dir, "whiteboard-assets");
  await mkdir(path.join(assetsDir, "fonts", "Excalifont"), { recursive: true });
  await writeFile(path.join(assetsDir, "whiteboard.js"), "// fake bundle\n");
  await writeFile(path.join(assetsDir, "whiteboard.css"), "body{}\n");
  await writeFile(path.join(assetsDir, "fonts", "Excalifont", "Excalifont-Regular.woff2"), "fake-font");
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, ARTIFACT_HTML);
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    whiteboardAssetsDir: assetsDir,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  }).then((res) => res.json());
  return {
    dir,
    base,
    key: opened.key,
    server,
    sameOrigin: { "content-type": "application/json", origin: base },
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("createWhiteboardFrameHtml loads only whiteboard-assets resources", () => {
  const html = createWhiteboardFrameHtml("channel-token");
  assert.match(html, /<link rel="stylesheet" href="\/whiteboard-assets\/whiteboard\.css">/);
  assert.match(html, /<script src="\/whiteboard-assets\/whiteboard\.js"><\/script>/);
  assert.match(html, /__lavishWhiteboardChannelToken="channel-token"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("whiteboard confirms sanitized links inside the frame", async () => {
  const frame = await readFile(new URL("../src/whiteboard-frame.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/whiteboard-frame.css", import.meta.url), "utf8");

  assert.doesNotMatch(frame, /window\.confirm/);
  assert.match(frame, /setAttribute\("role", "dialog"\)/);
  assert.match(frame, /setAttribute\("aria-modal", "true"\)/);
  assert.match(frame, /setAttribute\("aria-label", "Open external link"\)/);
  assert.match(frame, /event\.key === "Escape"/);
  assert.match(frame, /event\.key !== "Tab"/);
  assert.match(frame, /window\.open\(safe, "_blank", "noopener,noreferrer"\)/);
  assert.match(css, /\.wb-link-confirm/);
  assert.match(css, /data-lavish-whiteboard-theme="dark"/);
});

test("whiteboard channel tokens are signed and short lived", () => {
  const secret = Buffer.from("whiteboard-test-secret");
  const now = 1_700_000_000_000;
  const token = createWhiteboardChannelToken(secret, now);
  assert.equal(isValidWhiteboardChannelToken(token, secret, now), true);
  assert.equal(isValidWhiteboardChannelToken(`${token}x`, secret, now), false);
  assert.equal(isValidWhiteboardChannelToken(token, secret, now + 5 * 60_000 + 1), false);
});

test("GET /api/:key/mermaid-sources extracts ordered, entity-decoded sources with hashes", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const data = await fetch(`${ctx.base}/api/${ctx.key}/mermaid-sources`).then((res) => res.json());
    assert.equal(data.sources.length, 2);
    assert.equal(data.sources[0].index, 0);
    assert.equal(data.sources[0].source, "flowchart TD\n  A[Start] --> B{Ready?}");
    assert.equal(data.sources[0].hash, mermaidSourceHash("flowchart TD\n  A[Start] --> B{Ready?}"));
    assert.equal(data.sources[1].source, "sequenceDiagram\n  CLI->>Server: render");
  } finally {
    await ctx.close();
  }
});

test("whiteboard channel authentication accepts only the frame-issued token", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const frame = await fetch(`${ctx.base}/whiteboard-frame`).then((res) => res.text());
    const token = /__lavishWhiteboardChannelToken="([^"]+)"/.exec(frame)?.[1] || "";
    assert.ok(token);

    const accepted = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token }),
    });
    assert.equal(accepted.status, 200);

    const rejected = await fetch(`${ctx.base}/api/${ctx.key}/whiteboard-channel`, {
      method: "POST",
      headers: ctx.sameOrigin,
      body: JSON.stringify({ token: "forged" }),
    });
    assert.equal(rejected.status, 403);
  } finally {
    await ctx.close();
  }
});

test("whiteboard assets are served with Access-Control-Allow-Origin: * and traversal is blocked", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const bundle = await fetch(`${ctx.base}/whiteboard-assets/whiteboard.js`);
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get("access-control-allow-origin"), "*");

    const font = await fetch(`${ctx.base}/whiteboard-assets/fonts/Excalifont/Excalifont-Regular.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("access-control-allow-origin"), "*");

    const traversal = await fetch(`${ctx.base}/whiteboard-assets/..%2F..%2Fstate.json`);
    assert.equal(traversal.status, 403);

    const missing = await fetch(`${ctx.base}/whiteboard-assets/nope.js`);
    assert.equal(missing.status, 404);
  } finally {
    await ctx.close();
  }
});

test("the whiteboard frame page is served with the sandboxed chrome overlay pointing at it", async () => {
  const ctx = await startWhiteboardServer();
  try {
    const framePage = await fetch(`${ctx.base}/whiteboard-frame`);
    assert.equal(framePage.status, 200);
    assert.equal(framePage.headers.get("cache-control"), "no-store");
    assert.match(await framePage.text(), /whiteboard-assets\/whiteboard\.js/);

    const chrome = await fetch(`${ctx.base}/session/${ctx.key}`).then((res) => res.text());
    assert.match(chrome, /id="whiteboardFrame"[^>]*sandbox="allow-scripts allow-popups"/);
    assert.doesNotMatch(chrome, /whiteboardFrame[^>]*allow-same-origin/);
    // The artifact iframe's sandbox must be unchanged by this feature.
    assert.match(chrome, /id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads"/);
  } finally {
    await ctx.close();
  }
});
