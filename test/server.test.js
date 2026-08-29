import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  allowsAllHosts,
  buildAllowedHostnames,
  createChromeHtml,
  createIndexHtml,
  createSdkJs,
  displayPathParts,
  exportContentDisposition,
  extractArtifactHead,
  extractArtifactMeta,
  hasLiveReloadRootOptIn,
  hostnameFromHostHeader,
  isAllowedHostHeader,
  isAllowedRequestHost,
  resolveArtifactAsset,
  resolveDesignAssetPath,
  resolveIdleTimeoutMs,
  resolveWatchTarget,
  serve,
  sortEntriesByRecency,
} from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

async function chromeClientSource() {
  return readFile(new URL("../src/chrome-client.js", import.meta.url), "utf8");
}

async function chromeCssSource() {
  return normalizeCssForAssertions(await readFile(new URL("../src/chrome.css", import.meta.url), "utf8"));
}

function normalizeCssForAssertions(css) {
  return css
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/0\./g, ".");
}

test("server delegates artifact SDK generation to a dedicated source module", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

  assert.match(source, /from "\.\/artifact-sdk\.js"/);
});

test("server serves chrome browser behavior from a dedicated source file", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(source, /chrome-client\.js/);
  assert.match(html, /<script id="lavish-session" type="application\/json">/);
  assert.match(html, /<script src="\/chrome-client\.js"><\/script>/);
  assert.doesNotMatch(html, /<script>\s*const key=/);
});

test("server serves chrome styles from a dedicated source file", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(source, /chrome\.css/);
  assert.match(html, /<link rel="stylesheet" href="\/chrome\.css">/);
  assert.doesNotMatch(html, /<style>/);
});

test("export content disposition uses a safe fallback and encoded UTF-8 filename", () => {
  assert.equal(
    exportContentDisposition('/tmp/résumé "draft"\n.html'),
    "attachment; filename=\"r_sum_ _draft__.export.html\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22draft%22%0A.export.html",
  );
});

test("artifact assets resolve within the artifact directory", () => {
  const root = path.resolve("/tmp/lavish-artifact");

  assert.equal(resolveArtifactAsset(root, "style.css"), path.join(root, "style.css"));
  assert.equal(resolveArtifactAsset(root, "../secret.txt"), null);
});

test("chrome sandbox does not grant modal prompts", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.doesNotMatch(html, /sandbox="[^"]*allow-modals/);
});

test("artifact SDK script is valid JavaScript", () => {
  const js = createSdkJs("abc");

  assert.doesNotThrow(() => new Function(js));
});

test("artifact SDK ignores Lavish-owned annotation UI", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function isLavishUi/);
  assert.match(js, /closest\(["']\[data-lavish-ui\]["']\)/);
  assert.match(js, /data-lavish-ui/);
});

test("artifact SDK injects every shared mermaid node helper as a same-scope const", () => {
  const js = createSdkJs("abc");

  for (const name of ["isMermaidSvg"]) {
    assert.match(js, new RegExp(`const ${name}=`));
  }
  // The SDK reads its helpers off this bundle, so every export must land in it
  // or the browser would ReferenceError while enhancing diagrams.
  assert.match(js, /const mermaidHelpers=\{[^}]*isMermaidSvg[^}]*\}/);
});

test("chrome declares the Lavish design-system tokens", async () => {
  const css = await chromeCssSource();

  assert.match(css, /--ink-900:#0f1115/);
  assert.match(css, /--cream-100:#f7f3ea/);
  assert.match(css, /--brass-500:#f4c95d/);
  assert.match(css, /--font-serif:/);
  assert.match(css, /--font-sans:/);
  assert.match(css, /--text-display:92px/);
  assert.match(css, /--lh-display:1/);
  assert.match(css, /--space-32:64px/);
  assert.match(css, /--shadow-floating:0 20px 70px rgba\(0,0,0,.35\)/);
  assert.match(css, /--ease:cubic-bezier\(.2,.6,.2,1\)/);
  assert.match(css, /--dur-slow:320ms/);
  assert.match(css, /--bar-h:56px/);
});

test("chrome uses the annotation outline as the keyboard focus outline", async () => {
  const css = await chromeCssSource();

  assert.match(css, /:focus-visible\{outline:var\(--annotate-outline\);outline-offset:var\(--annotate-offset\)/);
  assert.match(css, /--annotate-outline:2px solid var\(--accent\)/);
  assert.match(css, /--annotate-offset:2px/);
});

test("chrome top bar follows the design mock wordmark and overflow menu treatment", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const css = await chromeCssSource();

  assert.match(html, /class="brand-mark">Lavish/);
  assert.doesNotMatch(html, /brand-support/);
  assert.match(css, /font-family:var\(--font-serif\)/);
  assert.match(html, /class="more-button" id="moreButton"/);
  assert.match(html, /class="menu more-menu" id="moreMenu" hidden/);
  assert.doesNotMatch(html, /class="file-input"/);
  assert.doesNotMatch(html, /class="divider"/);
  assert.doesNotMatch(html, /class="file-icon"/);
});

test("overflow menu shows the artifact path with a copy affordance", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact/index.html" });
  const css = await chromeCssSource();

  assert.match(html, /class="menu-label">Artifact</);
  assert.match(html, /class="menu-file" id="copyPath"[^>]*title="Copy path · \/tmp\/artifact\/index\.html"/);
  assert.match(html, /class="copy-hint"/);
  assert.match(css, /\.menu-file\{[^}]*font-family:var\(--font-mono\)/);
  assert.match(css, /\.copy-hint\.copied\{color:var\(--accent-hover\)/);
});

test("overflow menu path keeps the file name visible and elides the directories", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact/index.html" });
  const css = await chromeCssSource();

  assert.match(html, /class="path-head">\/tmp\/artifact\/</);
  assert.match(html, /class="path-tail">index\.html</);
  assert.match(css, /\.path-head\{[^}]*text-overflow:ellipsis/);
  assert.match(css, /\.path-head\{[^}]*min-width:0/);
  assert.match(css, /\.path-tail\{[^}]*flex:0 0 auto/);
  assert.match(css, /\.path-tail\{[^}]*max-width:100%/);
});

test("overflow menu path shortens the home directory to a tilde", () => {
  const home = homedir();
  const file = path.join(home, "projects", "demo", "artifact.html");
  const html = createChromeHtml({ key: "abc", file });

  assert.match(html, /class="path-head">~\/projects\/demo\/</);
  assert.match(html, /class="path-tail">artifact\.html</);
  // The copy affordance still carries the absolute path.
  assert.ok(html.includes(`title="Copy path · ${file}"`));
});

test("overflow menu path display tolerates Windows separators", () => {
  assert.deepEqual(
    displayPathParts("C:\\Users\\runneradmin\\projects\\demo\\artifact.html", "C:\\Users\\runneradmin"),
    { head: "~/projects/demo/", tail: "artifact.html" },
  );
});

test("chrome can copy the full file path from the overflow menu", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();

  assert.match(html, /"file":"\/tmp\/artifact\.html"/);
  assert.match(js, /const filePath = String\(sessionData\.file \|\| ""\)/);
  assert.match(js, /copyText\(filePath\)/);
  assert.match(js, /copyHintText\.textContent = "Copied"/);
  assert.match(js, /copyHintText\.textContent = "Copy"/);
});

test("overflow menu offers reload but no annotation, snapshot, or session controls", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();

  assert.match(html, /id="reloadArtifact"[^<]*>.*Reload artifact/);
  assert.doesNotMatch(html, /id="copySnapshot"/);
  assert.doesNotMatch(html, /id="end"/);
  assert.doesNotMatch(html, /id="annotation"/);
  assert.match(js, /event\.key === "Escape"/);
});

test("overflow menu offers a standalone HTML export that downloads a portable file", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();

  assert.match(html, /id="exportArtifact"[^<]*>.*Export standalone HTML/);
  assert.match(js, /const exportArtifactButton/);
  assert.match(js, /async function exportArtifact/);
  assert.match(js, /fetch\("\/api\/" \+ key \+ "\/export"\)/);
  assert.match(js, /link\.download = exportFileName\(\)/);
  assert.match(js, /exportArtifactButton\.onclick = exportArtifact/);
});

test("overflow menu offers publishing an ht-ml.app link via a share dialog", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /id="shareArtifact"[^<]*>.*Publish link/);
  assert.match(html, /id="shareDialog"/);
  assert.match(
    html,
    /Publish to <a class="share-link" href="https:\/\/ht-ml\.app" target="_blank" rel="noopener noreferrer">ht-ml\.app<\/a>/,
  );
  assert.match(html, /third-party hosting service, not part of Lavish/);
  assert.match(html, /id="sharePassword"/);
  assert.match(html, /id="shareUpdateKey"/);
  assert.match(html, /Without a password, the page is PUBLIC/);
  assert.match(html, /With a password, the page is PRIVATE/);
  assert.doesNotMatch(html, /Everything published is public/);
  assert.doesNotMatch(html, /Get a public link/);
  assert.match(css, /\.share-overlay/);
  assert.match(css, /\.share-overlay\{[^}]*z-index:80;/);
  assert.match(css, /\.share-card/);
  assert.match(css, /\.share-link/);
  assert.match(css, /box-shadow:var\(--shadow-floating\)/);
  // The codebase has no global [hidden] rule, so display-setting overlays need explicit
  // [hidden] rules or they show through before they should (e.g. the result block).
  assert.match(css, /\.share-overlay\[hidden\]\{display:none;?\}/);
  assert.match(css, /\.share-result\[hidden\]\{display:none;?\}/);
  assert.match(js, /const shareArtifactButton/);
  assert.match(js, /async function publishShare/);
  assert.match(js, /fetch\("\/api\/" \+ key \+ "\/share"/);
  assert.match(js, /shareUrlInput\.value = data\.url/);
  assert.match(js, /shareUpdateKeyInput\.value = data\.update_key/);
});

test("clipboard copy falls back when navigator clipboard rejects", async () => {
  const js = await chromeClientSource();

  assert.match(js, /async function copyText\(text\)/);
  assert.match(js, /await navigator\.clipboard\.writeText\(text\)/);
  assert.match(js, /document\.execCommand\("copy"\)/);
  assert.doesNotMatch(js, /navigator\.clipboard\.writeText\(text\)\.catch/);
});

test("chrome centers the top bar row while bottom-aligning the identity cluster", async () => {
  const css = await chromeCssSource();

  assert.match(css, /\.bar\{[^}]*align-items:center/);
  assert.match(css, /\.brand\{[^}]*height:22px/);
  assert.match(css, /\.brand\{[^}]*align-items:flex-end/);
});

test("chrome client script is valid JavaScript", async () => {
  const js = await chromeClientSource();

  assert.doesNotThrow(() => new Function(js));
});

test("hot reload resets iframe src instead of crossing sandbox location", async () => {
  const js = await chromeClientSource();

  assert.doesNotMatch(js, /contentWindow\.location\.reload/);
  assert.match(js, /frame\.src\s*=\s*artifactSrc \|\| frame\.src/);
});

test("artifact SDK reports only stable severe layout failures after fonts, resize, and animations settle", () => {
  const js = createSdkJs("abc");

  assert.match(js, /document\.fonts\?\.ready/);
  assert.match(js, /new ResizeObserver\(scheduleFinish\)/);
  assert.match(js, /document\.getAnimations/);
  assert.match(js, /activeAnimationTargets/);
  assert.match(js, /isAnimationAssociatedWithElement/);
  assert.match(js, /findStableLayoutFindings/);
  assert.match(js, /type:\s*["']lavish:layoutWarnings["']/);
  assert.match(js, /page-horizontal-overflow/);
  assert.match(js, /clipped-text/);
  assert.match(js, /overlapping-text/);
  assert.doesNotMatch(js, /element-scroll-overflow/);
  assert.doesNotMatch(js, /element-parent-overflow/);
});

test("artifact SDK verifies severe clipping from direct rendered text fragments", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function textFragmentsForAudit/);
  assert.match(js, /document\.createRange\(\)/);
  assert.match(js, /range\.getClientRects\(\)/);
  assert.match(js, /classifySevereTextOverflow/);
  assert.match(js, /isSemanticTextBoundary/);
  assert.match(js, /isStandardVisuallyHidden/);
  assert.match(js, /isIntentionalTextTruncation/);
  assert.match(js, /clippingBoundariesFor/);
  assert.match(js, /auditRequiredControlBounds/);
  assert.match(js, /viewport-unreachable-control/);
  assert.match(js, /auditUnreachableLeftText/);
  assert.match(js, /viewport-unreachable-content/);
  assert.match(js, /hasStandardVisuallyHiddenAncestor/);
  assert.match(js, /rootVerticalScrollLocked/);
  assert.match(js, /hasReachableVerticalScrollerAncestor/);
});

test("artifact SDK reports only near-total occlusion by an opaque sibling", () => {
  const js = createSdkJs("abc");

  assert.match(js, /function opaqueSiblingBlocker/);
  assert.match(js, /backgroundIsOpaque/);
  assert.match(js, /filter\(\(el\) => !isExcludedLayoutAuditElement\(el\)\)/);
  assert.match(js, /hasStandardVisuallyHiddenAncestor/);
  assert.match(js, /hasVisualMaskAncestor/);
  assert.match(js, /isDiagramLayoutElement/);
  assert.match(js, /isNearTotalOcclusion/);
  assert.match(js, /minRatio = 0\.9/);
});

test("artifact SDK reports its scroll position and restores it on request", () => {
  const js = createSdkJs("abc");

  assert.match(js, /addEventListener\(\s*["']scroll["']/);
  assert.match(js, /type:\s*["']lavish:scroll["']/);
  assert.match(js, /window\.scrollX/);
  assert.match(js, /window\.scrollY/);
  assert.match(js, /msg\.type === ["']lavish:restoreScroll["']/);
  assert.match(js, /window\.scrollTo\(/);
});

test("chrome remembers the artifact scroll position across reloads", async () => {
  const js = await chromeClientSource();

  assert.match(js, /let lastScroll = \{ x: 0, y: 0 \}/);
  assert.match(js, /msg\.type === ["']lavish:scroll["']/);
  assert.match(js, /type:\s*["']lavish:restoreScroll["']/);
  assert.match(js, /x:\s*lastScroll\.x,\s*y:\s*lastScroll\.y/);
});

test("chrome ignores Lavish postMessages not sent by the artifact iframe", async () => {
  const js = await chromeClientSource();

  assert.match(js, /event\.source\s*!==\s*frame\.contentWindow/);
});

test("chrome waits for the replacement server before version-driven reload", async () => {
  const js = await chromeClientSource();

  assert.match(js, /async function reloadAfterServerRestart\(\)/);
  assert.match(js, /let sawOutage = false/);
  assert.match(js, /if \(sawOutage && res\.ok\) \{/);
  assert.match(js, /addEventListener\("chrome-reload", \(\) => reloadAfterServerRestart\(\)\)/);
});

test("/health reports the server version so clients can detect upgrades", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, "9.9.9-test");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session URLs use the same IPv4 loopback host the server binds", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const body = await res.json();

    assert.match(body.url, /^http:\/\/127\.0\.0\.1:/);
    assert.doesNotMatch(body.url, /localhost/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session URLs use the configured linkHost while binding to loopback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    host: "127.0.0.1",
    linkHost: "host.example",
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const body = await res.json();

    assert.match(body.url, new RegExp(`^http://host\\.example:${server.port}/session/`));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session URLs can disable the layout gate for one open", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact, noGate: true }),
    });
    const body = await res.json();

    assert.match(body.url, /[?&]no-gate=1/);
    const chrome = await (await fetch(body.url)).text();
    assert.match(chrome, /<body class="lavish">/);
    assert.match(chrome, /id="layoutGateOverlay" hidden/);
    assert.match(chrome, /"layoutGateEnabled":false/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Issue a raw HTTP request so we can forge the Host header - browser `fetch`
// treats Host as a forbidden header and won't let us override it, but a DNS
// rebinding attack is exactly a real browser sending a foreign Host to this
// loopback port. Connect to 127.0.0.1 while presenting an arbitrary Host.
/**
 * @param {number} port
 * @param {string} pathname
 * @param {{ method?: string, host?: string, headers?: Record<string, string>, body?: string }} [options]
 */
function rawRequest(port, pathname, { method = "GET", host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (host !== undefined) finalHeaders.host = host;
    if (body !== undefined && finalHeaders["content-type"] === undefined) {
      finalHeaders["content-type"] = "application/json";
    }
    const req = httpRequest({ host: "127.0.0.1", port, path: pathname, method, headers: finalHeaders }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test("loopback server rejects forged non-loopback Host headers (DNS rebinding)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>top secret</h1></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    // A legitimate loopback caller opens a session and learns the deterministic key.
    const openRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.equal(openRes.status, 200);
    const { key } = await openRes.json();

    const evilHost = `evil.example:${server.port}`;

    // Arbitrary local file disclosure via a rebound fresh session open.
    const openForged = await rawRequest(server.port, "/api/sessions", {
      method: "POST",
      host: evilHost,
      body: JSON.stringify({ file: artifact }),
    });
    assert.equal(openForged.status, 403);
    assert.deepEqual(JSON.parse(openForged.body), { error: "forbidden host" });

    // Artifact contents must never reach a rebound origin.
    const artifactForged = await rawRequest(server.port, `/artifact/${key}/index.html`, { host: evilHost });
    assert.equal(artifactForged.status, 403);
    assert.doesNotMatch(artifactForged.body, /top secret/);

    // Forged layout findings injected into the report the agent reads back.
    const warningsForged = await rawRequest(server.port, `/api/${key}/layout-warnings`, {
      method: "POST",
      host: evilHost,
      body: JSON.stringify({ layout_warnings: [{ selector: "body", kind: "forged", severity: "error" }] }),
    });
    assert.equal(warningsForged.status, 403);

    // Reading the browser's verdict back.
    const auditForged = await rawRequest(server.port, `/api/${key}/layout-audit?timeoutMs=0`, { host: evilHost });
    assert.equal(auditForged.status, 403);

    // The rejected report must not have been stored: a legitimate read sees nothing.
    const auditCheck = await fetch(`http://127.0.0.1:${server.port}/api/${key}/layout-audit?timeoutMs=0`);
    assert.deepEqual(await auditCheck.json(), { status: "timeout", layout_warnings: [] });

    // Sanity: the same routes still work for a loopback Host.
    const artifactOk = await rawRequest(server.port, `/artifact/${key}/index.html`, {
      host: `127.0.0.1:${server.port}`,
    });
    assert.equal(artifactOk.status, 200);
    assert.match(artifactOk.body, /top secret/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("loopback server honors the configured link host but still rejects others", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    host: "127.0.0.1",
    linkHost: "host.example",
  });
  try {
    const linkHostReq = await rawRequest(server.port, "/health", { host: `host.example:${server.port}` });
    assert.equal(linkHostReq.status, 200);
    const localhostReq = await rawRequest(server.port, "/health", { host: `localhost:${server.port}` });
    assert.equal(localhostReq.status, 200);
    const loopbackReq = await rawRequest(server.port, "/health", { host: `127.0.0.1:${server.port}` });
    assert.equal(loopbackReq.status, 200);
    const forged = await rawRequest(server.port, "/health", { host: `evil.example:${server.port}` });
    assert.equal(forged.status, 403);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("server allows explicitly configured extra hosts and still rejects others", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    host: "127.0.0.1",
    linkHost: "127.0.0.1",
    allowedHosts: ["proxy.example"],
  });
  try {
    const proxy = await rawRequest(server.port, "/health", { host: `proxy.example:${server.port}` });
    assert.equal(proxy.status, 200);
    const loopback = await rawRequest(server.port, "/health", { host: `127.0.0.1:${server.port}` });
    assert.equal(loopback.status, 200);
    const forged = await rawRequest(server.port, "/health", { host: `evil.example:${server.port}` });
    assert.equal(forged.status, 403);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("server validates X-Forwarded-Host so it works behind a reverse proxy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    host: "127.0.0.1",
    linkHost: "127.0.0.1",
    allowedHosts: ["proxy.example"],
  });
  try {
    // A proxy rewrites Host to the loopback upstream and forwards the public host.
    const proxied = await rawRequest(server.port, "/health", {
      host: `127.0.0.1:${server.port}`,
      headers: { "x-forwarded-host": "proxy.example" },
    });
    assert.equal(proxied.status, 200);
    // A forwarded host that is not allowlisted is rejected even with a loopback Host.
    const forgedForward = await rawRequest(server.port, "/health", {
      host: `127.0.0.1:${server.port}`,
      headers: { "x-forwarded-host": "evil.example" },
    });
    assert.equal(forgedForward.status, 403);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a '*' entry in allowedHosts disables the Host guard entirely", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    host: "127.0.0.1",
    linkHost: "127.0.0.1",
    allowedHosts: ["*"],
  });
  try {
    const forged = await rawRequest(server.port, "/health", { host: `evil.example:${server.port}` });
    assert.equal(forged.status, 200);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("isAllowedHostHeader enforces the loopback Host allowlist", () => {
  const allowed = new Set(["127.0.0.1", "::1", "localhost", "host.example"]);
  assert.equal(isAllowedHostHeader("127.0.0.1:4387", allowed), true);
  assert.equal(isAllowedHostHeader("localhost", allowed), true);
  assert.equal(isAllowedHostHeader("[::1]:4387", allowed), true);
  assert.equal(isAllowedHostHeader("HOST.EXAMPLE:4387", allowed), true);
  assert.equal(isAllowedHostHeader("evil.example:4387", allowed), false);
  assert.equal(isAllowedHostHeader("evil.example", allowed), false);
  // Host is mandatory in HTTP/1.1 and every browser sends it, so missing or blank
  // is never legitimate and is rejected.
  assert.equal(isAllowedHostHeader(undefined, allowed), false);
  assert.equal(isAllowedHostHeader("", allowed), false);
  assert.equal(isAllowedHostHeader("   ", allowed), false);
});

test("hostnameFromHostHeader rejects trailing garbage after a bracketed IPv6 literal", () => {
  // Only an empty string or a `:port` suffix may follow the closing bracket;
  // anything else is a malformed authority and must not resolve to the IPv6 host.
  assert.equal(hostnameFromHostHeader("[::1]evil.com"), null);
  assert.equal(hostnameFromHostHeader("[::1]:4387"), "::1");
  assert.equal(hostnameFromHostHeader("[::1]"), "::1");
});

test("isAllowedHostHeader rejects a bracketed IPv6 host with trailing garbage", () => {
  const allowed = new Set(["127.0.0.1", "::1", "localhost"]);
  assert.equal(isAllowedHostHeader("[::1]evil.com", allowed), false);
  assert.equal(isAllowedHostHeader("[::1]:4387", allowed), true);
});

test("isAllowedRequestHost requires an allowlisted Host and validates X-Forwarded-Host", () => {
  const allowed = new Set(["127.0.0.1", "proxy.example"]);
  assert.equal(isAllowedRequestHost({ host: "127.0.0.1:4387" }, allowed), true);
  // Missing Host is blocked (HTTP/1.1 requires it).
  assert.equal(isAllowedRequestHost({ host: undefined }, allowed), false);
  assert.equal(isAllowedRequestHost({ host: "evil.example" }, allowed), false);
  // A reverse proxy's forwarded host must also be allowlisted.
  assert.equal(isAllowedRequestHost({ host: "127.0.0.1", forwardedHost: "proxy.example" }, allowed), true);
  assert.equal(isAllowedRequestHost({ host: "127.0.0.1", forwardedHost: "evil.example" }, allowed), false);
  // A spoofed forwarded host cannot widen access past the Host check.
  assert.equal(isAllowedRequestHost({ host: "evil.example", forwardedHost: "127.0.0.1" }, allowed), false);
  // With multiple forwarded values, the outermost (last) one is validated.
  assert.equal(
    isAllowedRequestHost({ host: "127.0.0.1", forwardedHost: "evil.example, proxy.example" }, allowed),
    true,
  );
  assert.equal(
    isAllowedRequestHost({ host: "127.0.0.1", forwardedHost: "proxy.example, evil.example" }, allowed),
    false,
  );
  // A blank forwarded host is treated as absent.
  assert.equal(isAllowedRequestHost({ host: "127.0.0.1", forwardedHost: "" }, allowed), true);
});

test("buildAllowedHostnames covers loopback, bind/link host, and explicit extras", () => {
  const loopback = buildAllowedHostnames({ host: "127.0.0.1", linkHost: "127.0.0.1" });
  assert.ok(loopback.has("127.0.0.1"));
  assert.ok(loopback.has("::1"));
  assert.ok(loopback.has("localhost"));

  // A concrete non-loopback interface bind is allowlisted so its own hostname works.
  const iface = buildAllowedHostnames({ host: "192.168.1.5", linkHost: "192.168.1.5" });
  assert.ok(iface.has("192.168.1.5"));

  // Wildcard binds are not connectable hostnames and never enter the allowlist.
  const wildcard = buildAllowedHostnames({ host: "0.0.0.0", linkHost: "127.0.0.1" });
  assert.equal(wildcard.has("0.0.0.0"), false);
  assert.ok(wildcard.has("127.0.0.1"));

  // Explicit extras are lowercased; the "*" sentinel is not a literal hostname.
  const extras = buildAllowedHostnames({
    host: "127.0.0.1",
    linkHost: "127.0.0.1",
    allowedHosts: ["Proxy.Example", "*"],
  });
  assert.ok(extras.has("proxy.example"));
  assert.equal(extras.has("*"), false);
});

test("allowsAllHosts detects the '*' opt-out sentinel", () => {
  assert.equal(allowsAllHosts(["*"]), true);
  assert.equal(allowsAllHosts([" * "]), true);
  assert.equal(allowsAllHosts(["proxy.example"]), false);
  assert.equal(allowsAllHosts([]), false);
});

test("serve rejects fast when the bind host is unavailable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  try {
    await assert.rejects(
      serve({
        port: 0,
        stateFile: path.join(dir, "state.json"),
        version: "9.9.9-test",
        host: "192.0.2.1",
      }),
      (error) => {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        return code === "EADDRNOTAVAIL" || code === "EADDRINUSE";
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/artifact serves files copied under the artifact directory", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const dir = path.join(parent, ".lavish");
  const assetDir = path.join(dir, "assets");
  const artifact = path.join(dir, "artifact.html");
  await mkdir(dir);
  await mkdir(assetDir);
  await writeFile(
    artifact,
    '<!doctype html><html><head><link rel="stylesheet" href="assets/style.css"></head><body><img src="./assets/icon.svg"></body></html>',
  );
  await writeFile(path.join(assetDir, "style.css"), "body { color: rgb(1 2 3); }\n");
  await writeFile(path.join(assetDir, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();
    const css = await fetch(`${base}/artifact/${session.key}/assets/style.css`);
    const svg = await fetch(`${base}/artifact/${session.key}/assets/icon.svg`);

    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /text\/css/);
    assert.equal(await css.text(), "body { color: rgb(1 2 3); }\n");
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.match(await svg.text(), /<svg/);
  } finally {
    await server.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("/chrome-client.js serves the extracted chrome client script", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/chrome-client.js`);
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/javascript/);
    assert.match(body, /const sessionData/);
    assert.match(body, /new EventSource\("\/events\/" \+ key\)/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/chrome.css serves the extracted chrome stylesheet", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/chrome.css`);
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/css/);
    assert.match(normalizeCssForAssertions(body), /--ink-900:#0f1115/);
    assert.match(normalizeCssForAssertions(body), /\.layout\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/design serves local Tailwind and DaisyUI artifact assets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const daisy = await fetch(`${base}/design/daisyui.css`);
    const tailwind = await fetch(`${base}/design/tailwindcss-browser.js`);
    const themes = await fetch(`${base}/design/daisyui-themes.css`);

    assert.equal(daisy.status, 200);
    assert.match(daisy.headers.get("content-type") || "", /text\/css/);
    assert.match(await daisy.text(), /\.btn/);
    assert.equal(tailwind.status, 200);
    assert.match(tailwind.headers.get("content-type") || "", /application\/javascript/);
    assert.match(await tailwind.text(), /tailwind/i);
    assert.equal(themes.status, 200);
    assert.match(themes.headers.get("content-type") || "", /text\/css/);
    assert.match(await themes.text(), /luxury/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("design asset resolver only trusts exact packaged design asset paths", () => {
  assert.equal(resolveDesignAssetPath("/design/daisyui.css/extra"), null);
  assert.equal(resolveDesignAssetPath("/design/tailwindcss-browser.js/extra"), null);
});

test("GET /api/:key/export inlines local assets and leaves remote references intact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(
    artifact,
    `<!doctype html><html><head><link rel="stylesheet" href="local.css">` +
      `<link rel="stylesheet" href="https://cdn.example/app.css"></head>` +
      `<body><img src="pic.png"><h1>Hi</h1><script src="/sdk.js?key=stale"></script></body></html>`,
  );
  await writeFile(path.join(dir, "local.css"), ".btn{color:green}");
  await writeFile(path.join(dir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const exportRes = await fetch(`${base}/api/${session.key}/export`);
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get("content-disposition") || "", /attachment; filename="artifact\.export\.html"/);
    const body = await exportRes.text();
    // local stylesheet + image inlined
    assert.match(body, /<style>\.btn\{color:green\}<\/style>/);
    assert.match(body, /<img src="data:image\/png;base64,iVBORw==">/);
    // injected SDK stripped
    assert.doesNotMatch(body, /sdk\.js/);
    // remote stylesheet left intact (not fetched/inlined)
    assert.match(body, /<link rel="stylesheet" href="https:\/\/cdn\.example\/app\.css">/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/:key/export sends a safe download filename header", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "résumé draft.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>");

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const exportRes = await fetch(`${base}/api/${session.key}/export`);

    assert.equal(exportRes.status, 200);
    assert.equal(
      exportRes.headers.get("content-disposition"),
      "attachment; filename=\"r_sum_ draft.export.html\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20draft.export.html",
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/:key/export reports unresolved local asset warning count", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, '<!doctype html><html><body><img src="missing.png"></body></html>');

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const exportRes = await fetch(`${base}/api/${session.key}/export`);
    const body = await exportRes.text();

    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.headers.get("x-lavish-export-warning-count"), "1");
    assert.equal(exportRes.headers.get("x-lavish-export-notice-count"), "0");
    assert.equal(exportRes.headers.get("x-lavish-export-warnings"), null);
    assert.match(body, /<img src="missing\.png">/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/:key/export counts notices separately from unresolved assets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(
    artifact,
    '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"></head><body><h1>Ship</h1></body></html>',
  );

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const exportRes = await fetch(`${base}/api/${session.key}/export`);
    const body = await exportRes.text();

    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.headers.get("x-lavish-export-warning-count"), "0");
    assert.equal(exportRes.headers.get("x-lavish-export-notice-count"), "1");
    assert.match(body, /Content-Security-Policy/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /api/:key/export returns 404 for an unknown session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/does-not-exist/export`);
    assert.equal(res.status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/share publishes the local-inlined artifact to ht-ml.app", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(
    artifact,
    '<!doctype html><html><head><link rel="stylesheet" href="local.css">' +
      '<link rel="stylesheet" href="https://cdn.example/app.css"></head>' +
      '<body><h1>Ship</h1><script src="/sdk.js?key=x"></script></body></html>',
  );
  await writeFile(path.join(dir, "local.css"), ".btn{color:red}");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ password: "pw" }),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 200);
    assert.deepEqual(body, {
      url: "https://abc123.ht-ml.app/",
      site_id: "abc123",
      update_key: "uk_secret",
      status: "active",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/v1/sites");
    // local stylesheet inlined, SDK stripped, remote stylesheet left intact (never fetched)
    assert.match(requests[0].body.html_content, /<style>\.btn\{color:red\}<\/style>/);
    assert.doesNotMatch(requests[0].body.html_content, /sdk\.js/);
    assert.match(requests[0].body.html_content, /<link rel="stylesheet" href="https:\/\/cdn\.example\/app\.css">/);
    assert.equal(requests[0].body.password, "pw");
  } finally {
    await server.close();
    await htmlApp.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/share returns unresolved local asset warnings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, '<!doctype html><html><body><img src="missing.png"><h1>Ship</h1></body></html>');

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({}),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 200);
    assert.equal(body.url, "https://abc123.ht-ml.app/");
    assert.equal(body.warnings.length, 1);
    assert.equal(body.unresolved_local_assets.length, 1);
    assert.equal("notices" in body, false);
    assert.equal(body.warnings[0].kind, "load-failed");
    assert.equal(body.warnings[0].ref, "missing.png");
    assert.match(body.warnings[0].reason || "", /ENOENT/);
    assert.equal(requests.length, 1);
    assert.match(requests[0].body.html_content, /<img src="missing\.png">/);
  } finally {
    await server.close();
    await htmlApp.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/share rejects cross-origin browser requests", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><title>x</title><h1>Private</h1>\n");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({}),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 403);
    assert.deepEqual(body, { error: "cross-origin share request rejected" });
    assert.equal(requests.length, 0);
  } finally {
    await server.close();
    await htmlApp.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/share rejects requests without provenance headers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><title>x</title><h1>Private</h1>\n");

  const requests = [];
  const htmlApp = await startFakeHtmlApp(requests);
  const previousApiUrl = process.env.LAVISH_AXI_HTML_APP_API_URL;
  process.env.LAVISH_AXI_HTML_APP_API_URL = `http://127.0.0.1:${htmlApp.port}`;

  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const sessionRes = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const session = await sessionRes.json();

    const shareRes = await fetch(`${base}/api/${session.key}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await shareRes.json();

    assert.equal(shareRes.status, 403);
    assert.deepEqual(body, { error: "cross-origin share request rejected" });
    assert.equal(requests.length, 0);
  } finally {
    await server.close();
    await htmlApp.close();
    restoreEnv("LAVISH_AXI_HTML_APP_API_URL", previousApiUrl);
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /shutdown stops the listener so the client can spawn a fresh server", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/shutdown`, { method: "POST" });
    assert.equal(res.status, 200);
    await server.done;
    await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/health`), /fetch failed|ECONNREFUSED/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveIdleTimeoutMs defaults, parses, and only explicit opt-outs disable", () => {
  assert.equal(resolveIdleTimeoutMs({}), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "" }), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "0" }), null);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "off" }), null);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "-1" }), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "30000ms" }), 30 * 60_000);
  assert.equal(resolveIdleTimeoutMs({ LAVISH_AXI_IDLE_TIMEOUT_MS: "later" }), 30 * 60_000);
});

async function expectDoneWithin(server, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`server did not shut down within ${ms}ms`)), ms);
  });
  try {
    await Promise.race([server.done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("server shuts itself down after the idle timeout with no connections", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    idleTimeoutMs: 150,
  });
  try {
    await expectDoneWithin(server, 2000);
    await assert.rejects(() => fetch(`http://127.0.0.1:${server.port}/health`), /fetch failed|ECONNREFUSED/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an open SSE connection keeps the server alive past the idle timeout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-serve-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    idleTimeoutMs: 500,
  });
  const controller = new AbortController();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    // Hold an SSE connection open so the server is never idle.
    const sse = fetch(`${base}/events/${key}`, { signal: controller.signal });
    sse.catch(() => {});
    await sse;
    await new Promise((resolve) => setTimeout(resolve, 750));
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    // Dropping the connection lets the idle timer fire and shut the server down.
    controller.abort();
    await expectDoneWithin(server, 2000);
  } finally {
    controller.abort();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hasLiveReloadRootOptIn detects the data attribute and meta opt-in", () => {
  assert.equal(hasLiveReloadRootOptIn("<html><body></body></html>"), false);
  assert.equal(hasLiveReloadRootOptIn(`<html data-lavish-live-reload-root><body></body></html>`), true);
  assert.equal(
    hasLiveReloadRootOptIn(`<html><head><meta name="lavish-live-reload" content="root"></head></html>`),
    true,
  );
});

test("hasLiveReloadRootOptIn ignores commented and text data attribute mentions", () => {
  assert.equal(hasLiveReloadRootOptIn(`<!-- <html data-lavish-live-reload-root> -->`), false);
  assert.equal(hasLiveReloadRootOptIn(`<html><body><code>data-lavish-live-reload-root</code></body></html>`), false);
});

test("resolveWatchTarget defaults to the artifact file so large sibling trees aren't scanned", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-watch-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  try {
    const target = await resolveWatchTarget({ file: artifact, key: "abc" });
    assert.equal(target.path, artifact);
    assert.equal(target.scope, "file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveWatchTarget upgrades to the artifact directory when data-lavish-live-reload-root opts in", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-watch-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, `<!doctype html><html data-lavish-live-reload-root><body></body></html>`);
  try {
    const target = await resolveWatchTarget({ file: artifact, key: "abc" });
    assert.equal(target.path, dir);
    assert.equal(target.scope, "directory");
    assert.ok(target.options.ignored, "directory watch should ignore default noise");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveWatchTarget falls back to file-only when the artifact can't be read", async () => {
  const target = await resolveWatchTarget({
    file: path.join(tmpdir(), `lavish-missing-artifact-${process.hrtime.bigint()}.html`),
    key: "abc",
  });
  assert.equal(target.scope, "file");
});

test("concurrent same-session opens create only one file watcher", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-watch-race-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body>race</body></html>");
  const key = sessionKey(artifact);
  const stateFile = path.join(dir, "state.json");
  await writeFile(
    stateFile,
    `${JSON.stringify({
      sessions: {
        [key]: {
          key,
          file: artifact,
          url: `http://localhost:0/session/${key}`,
          status: "open",
          pending_prompts: 0,
          prompts: [],
          dom_snapshot: "",
          chat: [],
          updated_at: new Date().toISOString(),
        },
      },
    })}\n`,
  );
  const logs = [];
  const server = await serve({
    port: 0,
    stateFile,
    version: "9.9.9-test",
    debug: true,
    log: (line) => logs.push(line),
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const responses = await Promise.all([fetch(`${base}/session/${key}`), fetch(`${base}/session/${key}`)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
    }
    assert.equal(logs.filter((line) => line.includes("watch session=")).length, 1);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/health and / stay responsive after opening two back-to-back sessions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-back-to-back-"));
  const a = path.join(dir, "a.html");
  const b = path.join(dir, "b.html");
  await writeFile(a, "<!doctype html><html><body>a</body></html>");
  await writeFile(b, "<!doctype html><html><body>b</body></html>");
  // Add a sibling tree so a recursive watcher would have to scan it.
  const big = path.join(dir, "big");
  await mkdir(big, { recursive: true });
  await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(path.join(big, `file-${i}.txt`), "x".repeat(64))));
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: a }),
    });
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: b }),
    });

    const start = Date.now();
    const healthRes = await Promise.race([
      fetch(`${base}/health`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("/health timed out")), 1000)),
    ]);
    assert.equal(healthRes.status, 200);
    assert.equal((await healthRes.json()).ok, true);

    const rootRes = await Promise.race([
      fetch(`${base}/`),
      new Promise((_, reject) => setTimeout(() => reject(new Error("/ timed out")), 1000)),
    ]);
    assert.equal(rootRes.status, 404);
    await rootRes.text().catch(() => {});

    assert.ok(Date.now() - start < 1000, "both probes should return well under one second");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("server debug logger receives session and watcher lifecycle events", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-debug-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const loggedArtifact = await canonicalFile(artifact);
  const logs = [];
  const server = await serve({
    port: 0,
    stateFile: path.join(dir, "state.json"),
    version: "9.9.9-test",
    debug: true,
    log: (line) => logs.push(line),
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    assert.ok(
      logs.some((line) => /session/i.test(line) && line.includes(loggedArtifact)),
      `expected a session-opened log line, got: ${JSON.stringify(logs)}`,
    );
    assert.ok(
      logs.some((line) => /watch/i.test(line)),
      `expected a watcher log line, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("layout gate curtain holds the artifact behind a card until the audit clears", async () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });
  const noGateHtml = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" }, { layoutGateEnabled: false });
  const js = await chromeClientSource();
  const css = await chromeCssSource();

  assert.match(html, /<body class="lavish layout-gate-active">/);
  assert.match(
    html,
    /<iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" data-artifact-src="\/artifact\/abc\/index\.html"><\/iframe>/,
  );
  assert.doesNotMatch(html, /<iframe id="artifact"[^>]* src=/);
  assert.match(html, /class="curtain layout-gate-overlay" id="layoutGateOverlay"/);
  assert.match(html, /<div class="curtain-card"><div class="curtain-title" id="layoutGateTitle">Checking layout/);
  assert.match(html, /class="curtain-copy" id="layoutGateCopy"/);
  assert.match(html, /class="button curtain-action" id="layoutGateAction" type="button">Show anyway/);
  assert.match(css, /body\.layout-gate-active iframe#artifact\{[^}]*opacity:0/);
  assert.match(css, /\.curtain-action\{[^}]*margin-top:var\(--space-8\)/);
  assert.match(js, /layoutGateAction\.onclick = \(\) => forceRevealLayoutGate\("manual"\)/);
  assert.match(noGateHtml, /<body class="lavish">/);
  assert.match(noGateHtml, /id="layoutGateOverlay" hidden/);
  assert.match(noGateHtml, /"layoutGateEnabled":false/);
});

async function startFakeHtmlApp(requests, responseBody = null) {
  const body = responseBody ?? {
    site_id: "abc123",
    url: "https://abc123.ht-ml.app/",
    update_key: "uk_secret",
    status: "active",
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("chrome falls back to a default favicon and title when none are provided", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" });

  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /<title>Lavish<\/title>/);
});

test("chrome adopts a favicon tag and tab title passed from the artifact", () => {
  const faviconTag =
    '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'><text>🗂️</text></svg>">';
  const html = createChromeHtml(
    { key: "abc", file: "/tmp/artifact.html" },
    { faviconTag, title: "Project Board · Lavish" },
  );

  assert.ok(html.includes(faviconTag), "artifact favicon tag is injected verbatim");
  assert.match(html, /<title>Project Board · Lavish<\/title>/);
});

test("chrome tab title from the artifact is HTML-escaped", () => {
  const html = createChromeHtml({ key: "abc", file: "/tmp/artifact.html" }, { title: "<script>alert(1)</script>" });

  assert.doesNotMatch(html, /<title><script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("extractArtifactHead pulls a data-URI favicon and title from the artifact head", () => {
  const artifact = `<!doctype html><html><head>
    <title>  Weekly   Board  </title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗂️</text></svg>">
    </head><body></body></html>`;
  const { faviconTag, title } = extractArtifactHead(artifact);

  assert.match(faviconTag, /rel="icon"/);
  assert.match(faviconTag, /viewBox='0 0 100 100'/, "data-URI '>' chars must not truncate the tag");
  assert.match(faviconTag, /<\/svg>">$/, "the full link tag is captured");
  assert.equal(title, "Weekly Board");
});

test("extractArtifactHead handles shortcut icon and absolute hrefs", () => {
  const artifact = `<head><link rel="shortcut icon" href="https://example.com/fav.ico"></head>`;
  const { faviconTag } = extractArtifactHead(artifact);

  assert.match(faviconTag, /href="https:\/\/example\.com\/fav\.ico"/);
});

test("extractArtifactHead reconstructs a clean tag and drops artifact-supplied attributes", () => {
  const hostile = extractArtifactHead(
    '<head><link rel="stylesheet icon" href="data:text/css,x" onload="steal()" onerror="steal()"></head>',
  );
  assert.equal(hostile.faviconTag, '<link rel="icon" href="data:text/css,x">');
  assert.doesNotMatch(hostile.faviconTag, /onload|onerror|steal|stylesheet/i);

  const breakout = extractArtifactHead(`<head><link rel='icon' href='data:image/png,x" onload="steal()'></head>`);
  assert.doesNotMatch(breakout.faviconTag, /onload="/i);
  assert.match(breakout.faviconTag, /^<link rel="icon" href="[^"]*">$/);
  assert.match(breakout.faviconTag, /&quot;/);
});

test("extractArtifactHead falls back to the default for missing or relative favicons", () => {
  const none = extractArtifactHead("<head><title>No icon</title></head>");
  assert.match(none.faviconTag, /data:image\/svg\+xml/);
  assert.equal(none.title, "No icon");

  // Relative hrefs would not resolve against the chrome page, so they fall back.
  const relative = extractArtifactHead('<head><link rel="icon" href="favicon.png"></head>');
  assert.match(relative.faviconTag, /data:image\/svg\+xml/);
});

test("extractArtifactHead does not hang on an unterminated link tag", () => {
  const start = process.hrtime.bigint();
  const result = extractArtifactHead("<head><link " + '"'.repeat(60000));
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 1000, `expected linear scan, took ${elapsedMs}ms`);
  assert.match(result.faviconTag, /data:image\/svg\+xml/);
});

test("extractArtifactHead reads the real href, not one hidden in another attribute", () => {
  // A `data-href` (longer attribute name) must not be mistaken for `href`; the
  // real, relative href should win and fall back to the default favicon.
  const dataHref = extractArtifactHead(
    '<head><link rel="icon" data-href="data:image/png,decoy" href="favicon.png"></head>',
  );
  assert.match(dataHref.faviconTag, /data:image\/svg\+xml/, "data-href decoy must not be adopted");

  // A `href=` sequence inside another attribute's quoted value must not be
  // adopted either; the genuine absolute href should be used.
  const inValue = extractArtifactHead(
    '<head><link rel="icon" title="see href=data:image/png,decoy" href="https://cdn.example.com/logo.png"></head>',
  );
  assert.equal(inValue.faviconTag, '<link rel="icon" href="https://cdn.example.com/logo.png">');
});

// ---------------------------------------------------------------------------
// Session index: artifact metadata
// ---------------------------------------------------------------------------

test("extractArtifactMeta reads the artifact title and description", () => {
  const html =
    "<!doctype html><html><head><title>\n  Q3   Roadmap\n</title>" +
    '<meta charset="utf-8"><meta name="description" content="  Plan   for   Q3  ">' +
    "</head><body><title>later</title></body></html>";

  assert.deepEqual(extractArtifactMeta(html), { title: "Q3 Roadmap", description: "Plan for Q3" });
});

test("extractArtifactMeta decodes the basic entities without double-decoding", () => {
  const html =
    "<html><head><title>Tools &amp; &quot;Toys&quot;</title>" +
    "<meta name='description' content='&lt;script&gt; it&#39;s fine &amp;lt;'>" +
    "</head></html>";

  assert.deepEqual(extractArtifactMeta(html), {
    title: 'Tools & "Toys"',
    description: "<script> it's fine &lt;",
  });
});

test("extractArtifactMeta returns empty strings when the head carries no metadata", () => {
  assert.deepEqual(extractArtifactMeta("<html><head></head><body>hi</body></html>"), { title: "", description: "" });
  assert.deepEqual(extractArtifactMeta(""), { title: "", description: "" });
  assert.deepEqual(extractArtifactMeta(null), { title: "", description: "" });
  // A `name`-suffixed attribute is not `name`.
  assert.deepEqual(extractArtifactMeta('<head><meta data-name="description" content="nope"></head>'), {
    title: "",
    description: "",
  });
});

test("extractArtifactMeta only scans the head of very large artifacts", () => {
  const padded = `${"<!-- pad -->".repeat(8000)}<title>Way too late</title>`;

  assert.ok(padded.length > 64 * 1024);
  assert.equal(extractArtifactMeta(padded).title, "");
});

// ---------------------------------------------------------------------------
// Session index: recency sorting
// ---------------------------------------------------------------------------

test("sortEntriesByRecency orders newest first and sinks undated entries", () => {
  const entries = [
    { key: "a", title: "Alpha", opened_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z" },
    { key: "b", title: "Bravo", opened_at: "2026-01-05T00:00:00.000Z" },
    { key: "c", title: "Charlie", opened_at: "whenever", updated_at: "" },
    { key: "d", title: "Delta", updated_at: "2026-01-02T00:00:00.000Z" },
  ];
  const snapshot = structuredClone(entries);

  const sorted = sortEntriesByRecency(entries);

  // Bravo is newest; Alpha and Delta tie on the same timestamp and break by title; Charlie sinks.
  assert.deepEqual(
    sorted.map((entry) => entry.key),
    ["b", "a", "d", "c"],
  );
  assert.notEqual(sorted, entries);
  assert.deepEqual(entries, snapshot);
});

test("sortEntriesByRecency tolerates junk input", () => {
  assert.deepEqual(sortEntriesByRecency([]), []);
  assert.deepEqual(sortEntriesByRecency(null), []);
});

// ---------------------------------------------------------------------------
// Session index: HTML
// ---------------------------------------------------------------------------

function indexEntry(overrides = {}) {
  return {
    key: "0123456789abcdef",
    url: "http://127.0.0.1:4387/session/plan",
    file: "/home/dev/plans/plan.html",
    title: "Plan",
    description: "",
    opened_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    missing: false,
    ...overrides,
  };
}

test("createIndexHtml groups cards by directory and sorts each group by title", () => {
  const html = createIndexHtml(
    [
      indexEntry({ key: "k1", title: "Zebra", file: "/home/dev/plans/zebra.html" }),
      indexEntry({ key: "k2", title: "Apple", file: "/home/dev/plans/apple.html" }),
      indexEntry({ key: "k3", title: "Report", file: "/home/dev/audits/report.html" }),
    ],
    { home: "/home/dev" },
  );

  // Directory headers sort alphabetically: ~/audits/ before ~/plans/.
  assert.ok(html.indexOf("~/audits/") < html.indexOf("~/plans/"));
  // Cards inside a group sort by title: Apple before Zebra.
  assert.ok(html.indexOf(">Apple<") < html.indexOf(">Zebra<"));
  assert.match(html, /<h2 class="group-dir">~\/plans\/<\/h2>/);
  assert.match(html, /data-keys="k2 k1"/);
  assert.match(html, /3 sessions on this machine/);
  // Folder view labels the age line "opened" and its cards carry no updated timestamp.
  assert.match(html, /<span class="age-label">opened<\/span>/);
  assert.equal(/data-updated-at="/.test(html), false);
  // The "By folder" toggle is the active one.
  assert.match(html, /<a class="toggle-option is-active" href="\/session" aria-current="page">By folder<\/a>/);
  assert.match(html, /Delete not opened in 7d/);
});

test("createIndexHtml renders the recent view as one flat, recency-sorted list", () => {
  const html = createIndexHtml(
    [
      indexEntry({ key: "k1", title: "Older", file: "/home/dev/a/older.html", updated_at: "2026-01-01T00:00:00.000Z" }),
      indexEntry({ key: "k2", title: "Newer", file: "/home/dev/b/newer.html", updated_at: "2026-03-01T00:00:00.000Z" }),
    ],
    { home: "/home/dev", sort: "recent" },
  );

  assert.ok(html.indexOf(">Newer<") < html.indexOf(">Older<"));
  // One flat section, no directory headers.
  assert.equal(/class="group-dir"/.test(html), false);
  assert.match(html, /data-updated-at="2026-03-01T00:00:00\.000Z"/);
  assert.match(html, /<span class="age-label">updated<\/span>/);
  assert.match(
    html,
    /<a class="toggle-option is-active" href="\/session\?sort=recent" aria-current="page">Recent<\/a>/,
  );
});

test("createIndexHtml marks only missing artifacts, with no review status to report", () => {
  const html = createIndexHtml(
    [
      indexEntry({ key: "k1", title: "Present" }),
      indexEntry({ key: "k3", title: "", file: "/home/dev/plans/gone.html", missing: true }),
    ],
    { home: "/home/dev" },
  );

  assert.match(html, /<span class="badge badge-missing">missing<\/span>/);
  assert.match(html, /class="card is-missing"/);
  assert.doesNotMatch(html, /badge-feedback|badge-pending|badge-ended|badge-open/);
  // A title-less artifact falls back to its file name.
  assert.match(html, /<h3 class="card-title">gone\.html<\/h3>/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:4387\/session\/plan"/);
});

test("createIndexHtml escapes artifact-controlled text", () => {
  const html = createIndexHtml(
    [
      indexEntry({
        title: '<script>alert("x")</script>',
        description: "5 > 3 && 2 < 4",
        url: 'http://127.0.0.1:4387/session/x"onerror="alert(1)',
      }),
    ],
    { home: "/home/dev" },
  );

  assert.equal(html.includes("<script>alert"), false);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /5 &gt; 3 &amp;&amp; 2 &lt; 4/);
  assert.match(html, /session\/x&quot;onerror=&quot;alert\(1\)/);
});

test("createIndexHtml renders an empty state with no sessions", () => {
  const html = createIndexHtml([], { home: "/home/dev" });

  assert.match(html, /No sessions yet\./);
  assert.match(html, /0 sessions on this machine/);
  assert.equal(/class="card /.test(html), false);
});

// ---------------------------------------------------------------------------
// Session index + deletion routes
// ---------------------------------------------------------------------------

async function openSession(base, file) {
  const res = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("GET /session lists every session on the machine, by folder and by recency", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-index-"));
  const nested = path.join(dir, "nested");
  await mkdir(nested);
  const plan = path.join(dir, "plan.html");
  const audit = path.join(nested, "audit.html");
  await writeFile(
    plan,
    '<html><head><title>Launch Plan</title><meta name="description" content="Ship it"></head></html>',
  );
  await writeFile(audit, "<html><head><title>Audit</title></head></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await openSession(base, plan);
    await openSession(base, audit);

    const folderRes = await fetch(`${base}/session`);
    assert.equal(folderRes.status, 200);
    assert.match(folderRes.headers.get("content-type") || "", /text\/html/);
    const folderHtml = await folderRes.text();
    assert.match(folderHtml, /2 sessions on this machine/);
    assert.match(folderHtml, /Launch Plan/);
    assert.match(folderHtml, /Ship it/);
    assert.match(folderHtml, /Audit/);
    assert.match(folderHtml, /class="group-dir"/);
    assert.match(folderHtml, /href="http:\/\/127\.0\.0\.1:\d+\/session\/plan"/);

    const recentHtml = await (await fetch(`${base}/session?sort=recent`)).text();
    assert.match(recentHtml, /aria-current="page">Recent</);
    assert.equal(/class="group-dir"/.test(recentHtml), false);
    assert.match(recentHtml, /data-updated-at="/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /session marks sessions whose artifact file is gone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-index-"));
  const kept = path.join(dir, "kept.html");
  const vanished = path.join(dir, "vanished.html");
  await writeFile(kept, "<html><head><title>Kept</title></head></html>");
  await writeFile(vanished, "<html><head><title>Vanished</title></head></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await openSession(base, kept);
    await openSession(base, vanished);
    await rm(vanished);

    const html = await (await fetch(`${base}/session`)).text();

    assert.match(html, /badge badge-missing/);
    // The unreadable artifact has no title left, so its card falls back to the file name.
    assert.match(html, /vanished\.html/);
    assert.match(html, /Kept/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/delete removes the session and its artifact file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-index-"));
  const doomed = path.join(dir, "doomed.html");
  const kept = path.join(dir, "kept.html");
  await writeFile(doomed, "<html><head><title>Doomed</title></head></html>");
  await writeFile(kept, "<html><head><title>Kept</title></head></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const opened = await openSession(base, doomed);
    await openSession(base, kept);

    const res = await fetch(`${base}/api/${opened.key}/delete`, { method: "POST" });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.status, "deleted");
    assert.equal(body.key, opened.key);
    assert.equal(existsSync(doomed), false);
    assert.equal(existsSync(kept), true);

    const html = await (await fetch(`${base}/session`)).text();
    assert.equal(/Doomed/.test(html), false);
    assert.match(html, /1 session on this machine/);
    assert.equal((await fetch(`${base}/session/${opened.key}`)).status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/:key/delete 404s an unknown key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-index-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<html><head><title>Here</title></head></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await openSession(base, artifact);

    const res = await fetch(`${base}/api/deadbeefdeadbeef/delete`, { method: "POST" });

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "session not found" });
    assert.equal(existsSync(artifact), true);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/batch-delete purges known keys and skips unknown ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-index-"));
  const first = path.join(dir, "first.html");
  const second = path.join(dir, "second.html");
  const kept = path.join(dir, "kept.html");
  await writeFile(first, "<html><head><title>First</title></head></html>");
  await writeFile(second, "<html><head><title>Second</title></head></html>");
  await writeFile(kept, "<html><head><title>Kept</title></head></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const one = await openSession(base, first);
    const two = await openSession(base, second);
    await openSession(base, kept);

    const res = await fetch(`${base}/api/batch-delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: [one.key, "deadbeefdeadbeef", two.key, ""] }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.status, "deleted");
    assert.equal(body.count, 2);
    assert.deepEqual(body.deleted, [one.key, two.key]);
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), false);
    assert.equal(existsSync(kept), true);

    const html = await (await fetch(`${base}/session`)).text();
    assert.match(html, /1 session on this machine/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /api/batch-delete tolerates a missing or malformed keys list", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-index-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<html><head><title>Here</title></head></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await openSession(base, artifact);

    const res = await fetch(`${base}/api/batch-delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: "not-an-array" }),
    });

    assert.deepEqual(await res.json(), { status: "deleted", deleted: [], count: 0 });
    assert.equal(existsSync(artifact), true);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// One-shot layout audit
// ---------------------------------------------------------------------------

async function startAuditServer() {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-audit-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body><h1>Hi</h1></body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const open = async () =>
    fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    }).then((res) => res.json());
  const { key } = await open();
  return {
    base,
    key,
    open,
    report: (layoutWarnings) =>
      fetch(`${base}/api/${key}/layout-warnings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout_warnings: layoutWarnings }),
      }),
    audit: (timeoutMs) => fetch(`${base}/api/${key}/layout-audit?timeoutMs=${timeoutMs}`).then((res) => res.json()),
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("the layout audit read returns a report the browser already posted", async () => {
  const ctx = await startAuditServer();
  try {
    const posted = await ctx.report([
      { selector: "main > div", kind: "text-clipped", axis: "horizontal", overflowPx: 120, severity: "error" },
    ]);
    assert.equal(posted.status, 200);
    assert.deepEqual(await posted.json(), { status: "recorded", layout_warnings: 1 });

    assert.deepEqual(await ctx.audit(0), {
      status: "reported",
      layout_warnings: [
        {
          selector: "main > div",
          kind: "text-clipped",
          axis: "horizontal",
          overflowPx: 120,
          viewportWidth: 0,
          severity: "error",
        },
      ],
    });
  } finally {
    await ctx.close();
  }
});

test("the layout audit read waits for a late report and resolves as soon as it lands", async () => {
  const ctx = await startAuditServer();
  try {
    const pending = ctx.audit(5000);
    setTimeout(() => {
      ctx.report([]).catch(() => {});
    }, 40);
    assert.deepEqual(await pending, { status: "reported", layout_warnings: [] });
  } finally {
    await ctx.close();
  }
});

test("the layout audit read times out clean when the browser never reports", async () => {
  const ctx = await startAuditServer();
  try {
    assert.deepEqual(await ctx.audit(30), { status: "timeout", layout_warnings: [] });
  } finally {
    await ctx.close();
  }
});

test("a fresh open discards the previous audit so the next read waits for the reloaded page", async () => {
  const ctx = await startAuditServer();
  try {
    await ctx.report([{ selector: "h1", kind: "text-clipped", severity: "error" }]);
    assert.equal((await ctx.audit(0)).status, "reported");

    await ctx.open();
    assert.deepEqual(await ctx.audit(30), { status: "timeout", layout_warnings: [] });
  } finally {
    await ctx.close();
  }
});

test("only proven severe findings survive normalization into the audit report", async () => {
  const ctx = await startAuditServer();
  try {
    await ctx.report([
      { selector: "aside", kind: "cosmetic-nudge", severity: "warning" },
      "not-an-object",
      { selector: "main", kind: "text-clipped", severity: "error", axis: "sideways", overflowPx: "nope", evil: 1 },
    ]);

    assert.deepEqual(await ctx.audit(0), {
      status: "reported",
      layout_warnings: [{ selector: "main", kind: "text-clipped", overflowPx: 0, viewportWidth: 0, severity: "error" }],
    });
  } finally {
    await ctx.close();
  }
});

test("layout audit routes 404 on an unknown session", async () => {
  const ctx = await startAuditServer();
  try {
    assert.equal((await fetch(`${ctx.base}/api/0123456789abcdef/layout-audit?timeoutMs=0`)).status, 404);
    const report = await fetch(`${ctx.base}/api/0123456789abcdef/layout-warnings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout_warnings: [] }),
    });
    assert.equal(report.status, 404);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// Readable slug URLs
// ---------------------------------------------------------------------------

test("POST /api/sessions returns a readable slug and a slug-based session URL", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-slug-"));
  const artifact = path.join(dir, "Launch Plan.html");
  await writeFile(artifact, "<html><head><title>Launch Plan</title></head><body>hi</body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const body = await openSession(base, artifact);

    assert.equal(body.slug, "launch-plan");
    assert.equal(body.url, `${base}/session/launch-plan`);
    assert.equal(body.key, sessionKey(await canonicalFile(artifact)));

    // The slug URL serves the chrome, which still addresses the artifact by sha256 key.
    const chromeRes = await fetch(body.url);
    assert.equal(chromeRes.status, 200);
    const chrome = await chromeRes.text();
    assert.match(chrome, new RegExp(`/artifact/${body.key}/index\\.html`));
    assert.match(chrome, new RegExp(`"key":"${body.key}"`));
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /session/:key still resolves legacy sha256 session URLs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-slug-"));
  const artifact = path.join(dir, "plan.html");
  await writeFile(artifact, "<html><head><title>Plan</title></head><body>hi</body></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const body = await openSession(base, artifact);

    const legacy = await fetch(`${base}/session/${body.key}`);
    const slugged = await fetch(`${base}/session/${body.slug}`);

    assert.equal(legacy.status, 200);
    assert.equal(slugged.status, 200);
    assert.equal((await fetch(`${base}/session/no-such-session`)).status, 404);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sessions with the same file name get distinct slugs that both resolve", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-slug-"));
  const nested = path.join(dir, "nested");
  await mkdir(nested);
  const first = path.join(dir, "plan.html");
  const second = path.join(nested, "plan.html");
  await writeFile(first, "<html><head><title>First</title></head></html>");
  await writeFile(second, "<html><head><title>Second</title></head></html>");
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const one = await openSession(base, first);
    const two = await openSession(base, second);

    assert.equal(one.slug, "plan");
    assert.equal(two.slug, "plan-2");
    assert.equal((await fetch(`${base}/session/plan`)).status, 200);
    assert.equal((await fetch(`${base}/session/plan-2`)).status, 200);

    // Re-opening keeps the slug stable, so a shared link never points at another artifact.
    const reopened = await openSession(base, first);
    assert.equal(reopened.slug, "plan");
    assert.equal(reopened.url, `${base}/session/plan`);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
