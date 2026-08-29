import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chokidar from "chokidar";
import express from "express";

import {
  classifySevereTextOverflow,
  classifyMaterialRectEscape,
  createArtifactSdk,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isNearTotalOcclusion,
} from "./artifact-sdk.js";
import * as mermaidNode from "./mermaid-node.js";
import { extractMermaidSources, mermaidSourceHash } from "./mermaid-source.js";
import {
  buildSelfContainedHtml,
  exportFileName,
  exportWarningSummaries,
  splitExportWarnings,
} from "./export-bundle.js";
import { publishToHtmlApp } from "./html-app.js";
import { injectLavishSdk } from "./html-transform.js";
import { bindHost, extraAllowedHosts, hostForUrl, IPV6_LOOPBACK_HOST, linkHost, LOOPBACK_HOST } from "./paths.js";
import { canonicalFile, SessionStore, sessionKey } from "./session-store.js";

const chromeClientUrl = new URL("./chrome-client.js", import.meta.url);
const chromeCssUrl = new URL("./chrome.css", import.meta.url);
const designAssetUrls = {
  "daisyui.css": {
    packaged: new URL("./design/daisyui.css", import.meta.url),
    source: new URL("../node_modules/daisyui/daisyui.css", import.meta.url),
    type: "text/css",
  },
  "daisyui-themes.css": {
    packaged: new URL("./design/daisyui-themes.css", import.meta.url),
    source: new URL("../node_modules/daisyui/themes.css", import.meta.url),
    type: "text/css",
  },
  "tailwindcss-browser.js": {
    packaged: new URL("./design/tailwindcss-browser.js", import.meta.url),
    source: new URL("../node_modules/@tailwindcss/browser/dist/index.global.js", import.meta.url),
    type: "application/javascript",
  },
};

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const WHITEBOARD_CHANNEL_TOKEN_TTL_MS = 5 * 60_000;
// How long `lavish-axi <file>` may wait for the browser's render-time layout audit before
// returning anyway. Matched to the chrome's own layout-gate max hold so the CLI and the browser
// give up on a missing verdict at the same moment; a heavy page (webfonts, a CDN Tailwind
// compile, several diagrams) routinely needs several seconds to settle before the audit runs.
// Clean pages answer as soon as the audit lands, so the full budget only elapses when the
// browser never reports - and a missing audit is uncertainty, not a defect, so the open still
// succeeds and reports no findings.
export const DEFAULT_LAYOUT_AUDIT_WAIT_MS = 12_000;

// The whiteboard frame bundle (Excalidraw + Mermaid converter + React) is
// produced by `scripts/build.js` into dist/whiteboard. Packaged runs find it
// next to the served bundle; source runs (node bin/lavish-axi.js) fall back to
// the repo's dist output, so `pnpm run build` must have run at least once.
export function defaultWhiteboardAssetsDir() {
  const packaged = fileURLToPath(new URL("./whiteboard", import.meta.url));
  if (existsSync(packaged)) return packaged;
  return fileURLToPath(new URL("../dist/whiteboard", import.meta.url));
}

export function createWhiteboardChannelToken(secret, now = Date.now()) {
  const payload = `${now}.${crypto.randomBytes(24).toString("base64url")}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function isValidWhiteboardChannelToken(token, secret, now = Date.now()) {
  const [issuedAtText, nonce, signature, extra] = String(token || "").split(".");
  if (extra !== undefined || !/^\d{13}$/.test(issuedAtText) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) return false;
  const issuedAt = Number(issuedAtText);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now || now - issuedAt > WHITEBOARD_CHANNEL_TOKEN_TTL_MS)
    return false;
  const expected = crypto.createHmac("sha256", secret).update(`${issuedAtText}.${nonce}`).digest("base64url");
  const actualBuffer = Buffer.from(signature || "", "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

// A detached server should not live forever. When no browser chrome (SSE) is connected for
// this long, the server shuts itself down so it stops dangling. The next `lavish-axi <file>`
// invocation re-spawns a fresh server and adopts sessions from state.json. Set
// LAVISH_AXI_IDLE_TIMEOUT_MS to 0/off to disable, or to a custom millisecond budget.
export function resolveIdleTimeoutMs(env = process.env) {
  const raw = env.LAVISH_AXI_IDLE_TIMEOUT_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return value;
}

export async function serve({
  port,
  stateFile,
  version = "",
  debug = false,
  log = null,
  idleTimeoutMs = resolveIdleTimeoutMs(),
  host = bindHost(),
  linkHost: linkHostName = linkHost(),
  allowedHosts = extraAllowedHosts(),
  whiteboardAssetsDir = defaultWhiteboardAssetsDir(),
}) {
  const app = express();
  const store = new SessionStore(stateFile);
  const events = new EventEmitter();
  const watchers = new Map();
  // Latest render-time layout audit per session, in memory only. It exists to answer the one
  // bounded `GET /api/:key/layout-audit` the CLI makes right after opening a browser; nothing
  // subscribes to it afterward, so it never belongs in state.json.
  /** @type {Map<string, { layout_warnings: any[] }>} */
  const layoutAudits = new Map();
  const sseClients = new Set();
  const whiteboardChannelSecret = crypto.randomBytes(32);
  const verbose = debug || process.env.LAVISH_AXI_DEBUG === "1";
  const writeLog = typeof log === "function" ? log : (line) => process.stderr.write(`${line}\n`);
  const logEvent = verbose ? (line) => writeLog(`[lavish] ${line}`) : null;
  let publicPort = port;

  // DNS-rebinding guard. isSameOriginRequest (used on /share and the whiteboard
  // channel route) stops classic cross-origin CSRF but NOT DNS rebinding: a page
  // that rebinds its own domain to this loopback port sends that domain in both
  // Origin and Host, so the two still match. The robust defense is a Host-header
  // allowlist - a rebound browser carries the attacker's domain in Host, which is
  // never one of the hostnames this server answers to.
  //
  // Loopback names are always accepted. Binding to a concrete interface
  // (LAVISH_AXI_HOST) or naming a link host (LAVISH_AXI_LINK_HOST) adds that host,
  // so an operator who intentionally exposes the server on a specific interface
  // keeps rebinding protection while their chosen hostname works. Additional
  // names (a reverse-proxy hostname, extra interfaces) are an explicit opt-in via
  // LAVISH_AXI_ALLOWED_HOSTS; a lone "*" there disables the guard for operators
  // who front the server with their own authentication. When a reverse proxy sits
  // in front, X-Forwarded-Host is validated too (see isAllowedRequestHost).
  const allowedHostnames = buildAllowedHostnames({ host, linkHost: linkHostName, allowedHosts });
  if (!allowsAllHosts(allowedHosts)) {
    app.use((req, res, next) => {
      const requestHost = { host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"] };
      if (isAllowedRequestHost(requestHost, allowedHostnames)) {
        next();
        return;
      }
      logEvent?.(
        `rejected request with disallowed host host=${req.headers.host ?? ""} x-forwarded-host=${req.headers["x-forwarded-host"] ?? ""} path=${req.path}`,
      );
      res.status(403).json({ error: "forbidden host" });
    });
  }

  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (req, res) => {
    res.json({ ok: true, app: "lavish-axi", version });
  });

  let shutdownResolve;
  const done = new Promise((resolve) => {
    shutdownResolve = resolve;
  });

  app.post("/shutdown", (req, res) => {
    res.json({ status: "shutting-down" });
    // Defer until after the response flushes so the client gets confirmation.
    setImmediate(shutdown);
  });

  app.post("/api/sessions", async (req, res, next) => {
    try {
      const file = await canonicalFile(req.body.file);
      const key = sessionKey(file);
      // The slug is minted (or recovered) by the store, so the URL is built from it rather than
      // the other way around.
      const session = await store.upsertSession(
        file,
        (slug) => `http://${hostForUrl(linkHostName)}:${publicPort}/session/${slug}`,
      );
      const url = shouldDisableLayoutGateOpen(req.body || {}) ? appendNoGateParam(session.url) : session.url;
      // A re-open gets a fresh audit from the reloaded page, so the previous verdict must not
      // satisfy the wait that follows this response.
      layoutAudits.delete(key);
      logEvent?.(`session opened key=${key} slug=${session.slug} file=${file}`);
      await watchSession(session, watchers, events, logEvent);
      res.json({ key, file, slug: session.slug, url, status: "opened" });
    } catch (error) {
      next(error);
    }
  });

  // The chrome forwards the artifact's render-time layout audit here. Findings are kept in
  // memory for exactly one bounded read by the CLI's open command and are never persisted.
  app.post("/api/:key/layout-warnings", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const layoutWarnings = normalizeLayoutWarnings(req.body?.layout_warnings || req.body?.layoutWarnings || []);
      layoutAudits.set(req.params.key, { layout_warnings: layoutWarnings });
      events.emit("layout-audit", req.params.key);
      res.json({ status: "recorded", layout_warnings: layoutWarnings.length });
    } catch (error) {
      next(error);
    }
  });

  // Bounded wait for the browser's verdict on the artifact just opened. This is the only
  // request the agent makes after opening a session, and it always answers: `reported` with
  // the findings, or `timeout` when the browser did not get far enough in time. A timeout is
  // never treated as a defect - an absent audit is uncertainty, so it fails open.
  app.get("/api/:key/layout-audit", async (req, res, next) => {
    try {
      const key = req.params.key;
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const requested = Number(req.query.timeoutMs);
      const timeoutMs = Number.isFinite(requested)
        ? Math.max(0, Math.min(requested, 60_000))
        : DEFAULT_LAYOUT_AUDIT_WAIT_MS;
      const respond = (audit) => {
        if (res.writableEnded) return;
        res.json(
          audit
            ? { status: "reported", layout_warnings: audit.layout_warnings }
            : { status: "timeout", layout_warnings: [] },
        );
      };
      const existing = layoutAudits.get(key);
      if (existing) {
        respond(existing);
        return;
      }
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        events.off("layout-audit", onAudit);
      };
      function onAudit(auditedKey) {
        if (auditedKey !== key) return;
        cleanup();
        respond(layoutAudits.get(key));
      }
      timer = setTimeout(() => {
        cleanup();
        respond(null);
      }, timeoutMs);
      timer.unref?.();
      events.on("layout-audit", onAudit);
      req.on("close", cleanup);
    } catch (error) {
      next(error);
    }
  });

  // Static export: inline the artifact's local assets into one portable HTML file the user can
  // open from disk or host anywhere, with no dependency on this server. Remote CDN/font URLs are
  // left as references for the browser to load, so the export needs network to render those.
  app.get("/api/:key/export", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      const { unresolved, notices } = splitExportWarnings(warnings);
      res.setHeader("content-disposition", exportContentDisposition(session.file));
      res.setHeader("x-lavish-export-warning-count", String(unresolved.length));
      res.setHeader("x-lavish-export-notice-count", String(notices.length));
      res.type("html").send(html);
    } catch (error) {
      next(error);
    }
  });

  // Hosted share: build the local-inlined artifact and publish it to ht-ml.app, a third-party
  // hosting service not part of Lavish, returning the share URL. Publishing sends the artifact
  // to ht-ml.app's servers. Remote CDN/font references are left intact for the viewer's browser
  // to load.
  // Publishing creates a public third-party page unless a password is supplied, so this is gated
  // behind a same-origin check - a cross-origin page must not be able to drive a publish via the
  // loopback server.
  app.post("/api/:key/share", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req)) {
        res.status(403).json({ error: "cross-origin share request rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const body = req.body || {};
      const source = await readFile(session.file, "utf8");
      const root = path.dirname(session.file);
      const { html, warnings } = await buildSelfContainedHtml(source, {
        baseDir: root,
        confineDir: root,
        resolveAbsolute: resolveDesignAssetPath,
      });
      let site;
      try {
        site = await publishToHtmlApp(html, { password: optionalBodyString(body.password) });
      } catch (error) {
        res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
        return;
      }
      const { unresolved, notices } = splitExportWarnings(warnings);
      res.json({
        ...site,
        ...(warnings.length ? { warnings: exportWarningSummaries(warnings) } : {}),
        ...(unresolved.length ? { unresolved_local_assets: exportWarningSummaries(unresolved) } : {}),
        ...(notices.length ? { notices: exportWarningSummaries(notices) } : {}),
      });
    } catch (error) {
      next(error);
    }
  });

  // Machine-wide index of every session in state.json. Sessions are otherwise only reachable by
  // a URL the agent printed once, so a closed tab used to mean a lost review surface.
  app.get("/session", async (req, res, next) => {
    try {
      const sessions = await store.listSessions();
      const entries = await Promise.all(
        sessions.map(async (session) => {
          const meta = await readArtifactMeta(session.file);
          return {
            key: session.key,
            url: session.url,
            file: session.file,
            title: meta.title,
            description: meta.description,
            opened_at: session.opened_at || "",
            updated_at: session.updated_at || "",
            missing: meta.missing,
          };
        }),
      );
      const sort = String(req.query.sort || "") === "recent" ? "recent" : "folder";
      res.type("html").send(createIndexHtml(entries, { sort }));
    } catch (error) {
      next(error);
    }
  });

  // Deleting a session from the index also deletes the artifact file: the index is the only
  // surface where a user asks to be rid of an artifact entirely, and leaving the HTML behind
  // would have the next `lavish-axi <file>` resurrect a session they just removed.
  async function purgeSession(session) {
    await unlink(session.file).catch((error) => {
      if (!error || error.code !== "ENOENT") throw error;
    });
    await store.deleteSession(session.key);
    layoutAudits.delete(session.key);
    // The file is gone, so its watcher can only report the deletion to nobody.
    const watcher = watchers.get(session.key);
    if (watcher) {
      watchers.delete(session.key);
      watcher.close().catch(() => {});
    }
    logEvent?.(`session deleted key=${session.key} file=${session.file}`);
  }

  app.post("/api/:key/delete", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      await purgeSession(session);
      res.json({ status: "deleted", key: session.key, file: session.file });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  // Bulk path for the index's "Delete all" and 7-day prune. Unknown keys are skipped rather than
  // failing the batch, so a stale page whose cards were already deleted elsewhere still works.
  app.post("/api/batch-delete", async (req, res, next) => {
    try {
      const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
      const deleted = [];
      for (const rawKey of keys) {
        const session = await store.findByKey(String(rawKey || ""));
        if (!session) continue;
        await purgeSession(session);
        deleted.push(session.key);
      }
      res.json({ status: "deleted", deleted, count: deleted.length });
      await shutdownIfNoLiveSessions();
    } catch (error) {
      next(error);
    }
  });

  app.get("/session/:key", async (req, res, next) => {
    try {
      // New URLs carry the readable slug; sha256 keys printed by earlier versions still resolve.
      const session = (await store.findByKey(req.params.key)) || (await store.findBySlug(req.params.key));
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      await watchSession(session, watchers, events, logEvent);
      const artifactHtml = await readFile(session.file, "utf8").catch(() => "");
      const { faviconTag, title } = extractArtifactHead(artifactHtml);
      res.type("html").send(
        createChromeHtml(session, {
          layoutGateEnabled: shouldEnableLayoutGate(req.query || {}),
          faviconTag,
          title: title ? `${title} · Lavish` : "Lavish Editor",
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key", (req, res) => {
    res.redirect(`/artifact/${req.params.key}/index.html`);
  });

  app.get(/^\/artifact\/([^/]+)\/index\.html$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const html = await readFile(session.file, "utf8");
      res.type("html").send(injectLavishSdk(html, key));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const key = req.params[0];
      const assetPath = req.params[1];
      const session = await store.findByKey(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      const root = path.dirname(session.file);
      const file = resolveArtifactAsset(root, assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", async (req, res, next) => {
    try {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Flush the headers immediately with a comment frame. Without a first write the response
      // can sit buffered, so a client that awaits the response before subscribing would hang
      // until the first real event - which, for a page that never reloads, is never.
      res.write(": connected\n\n");
      sseClients.add(res);
      refreshIdleTimer();
      const sendReload = (key) => {
        if (key === req.params.key) {
          res.write("event: reload\ndata: {}\n\n");
        }
      };
      events.on("reload", sendReload);
      req.on("close", () => {
        sseClients.delete(res);
        events.off("reload", sendReload);
        refreshIdleTimer();
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome-client.js", async (req, res, next) => {
    try {
      res.type("application/javascript").send(await readFile(chromeClientUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/chrome.css", async (req, res, next) => {
    try {
      res.type("text/css").send(await readFile(chromeCssUrl, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/design/:asset", async (req, res, next) => {
    try {
      const asset = designAssetUrls[req.params.asset];
      if (!asset) {
        res.status(404).send("Not found");
        return;
      }
      res.type(asset.type).send(await readDesignAsset(asset));
    } catch (error) {
      next(error);
    }
  });

  app.get("/sdk.js", (req, res) => {
    res.type("application/javascript").send(createSdkJs(String(req.query.key || "")));
  });

  // The whiteboard frame page. Hosted by the chrome in a dedicated sandboxed
  // iframe (allow-scripts allow-popups, no allow-same-origin) so untrusted
  // Mermaid text renders - and the Excalidraw editor runs - inside an opaque
  // origin, matching the artifact iframe's trust posture. The chrome passes
  // the diagram source and saved scene over postMessage after the frame
  // reports ready.
  app.get("/whiteboard-frame", (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.type("html").send(createWhiteboardFrameHtml(createWhiteboardChannelToken(whiteboardChannelSecret)));
  });

  // Whiteboard bundle, stylesheet, and vendored Excalidraw fonts. The frame
  // runs in an opaque origin, and font fetches from an opaque origin are
  // CORS-gated, so this static, public-content route must answer with
  // Access-Control-Allow-Origin: * or every canvas font falls back.
  app.get(/^\/whiteboard-assets\/(.+)$/, (req, res, next) => {
    try {
      const file = resolveArtifactAsset(whiteboardAssetsDir, req.params[0]);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      if (!existsSync(file)) {
        res
          .status(404)
          .send(existsSync(whiteboardAssetsDir) ? "Not found" : "Whiteboard bundle missing - run `pnpm run build`");
        return;
      }
      res.setHeader("access-control-allow-origin", "*");
      // Revalidate on every use (304 via Last-Modified/ETag): the bundle URL
      // is unversioned, and a memory-cached stale bundle after an upgrade or
      // local rebuild is far worse than cheap loopback revalidations.
      res.setHeader("cache-control", "no-cache");
      // Traversal is already rejected by resolveArtifactAsset; "allow" keeps
      // dot components in the assets dir's own absolute path (e.g. a checkout
      // under a dot-directory) from 403ing every asset.
      res.sendFile(file, { dotfiles: "allow" });
    } catch (error) {
      next(error);
    }
  });

  // Mermaid sources for a session's artifact, extracted from the HTML on disk
  // in document order so `index` matches the browser's `.mermaid` element
  // order. The hash feeds whiteboard staleness detection.
  app.get("/api/:key/mermaid-sources", async (req, res, next) => {
    try {
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      const html = await readFile(session.file, "utf8").catch(() => "");
      const sources = extractMermaidSources(html).map(({ index, source }) => ({
        index,
        source,
        hash: mermaidSourceHash(source),
      }));
      res.json({ sources });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/whiteboard-channel", async (req, res, next) => {
    try {
      if (!isSameOriginRequest(req)) {
        res.status(403).json({ error: "cross-origin whiteboard channel request rejected" });
        return;
      }
      const session = await store.findByKey(req.params.key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (!isValidWhiteboardChannelToken(req.body?.token, whiteboardChannelSecret)) {
        res.status(403).json({ error: "invalid whiteboard channel" });
        return;
      }
      res.json({ status: "authenticated" });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, _next) => {
    // Body-parser errors carry a meaningful HTTP status (413 payload-too-large,
    // 400 malformed JSON); surface it instead of flattening everything to 500.
    const status = Number(error?.statusCode || error?.status) || 500;
    res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
  });

  const httpServer = await new Promise((resolve, reject) => {
    const s = app.listen(port, host, () => {
      if (s.address()) resolve(s);
    });
    s.once("error", reject);
  });
  publicPort = httpServer.address().port;

  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // Tell open browser chromes to reload before we drop their SSE connection. The new
    // server adopts the session via state.json once it binds, so the reloaded chrome
    // immediately gets the upgraded HTML/CSS/JS.
    for (const res of sseClients) {
      try {
        res.write("event: chrome-reload\ndata: {}\n\n");
        res.end();
      } catch {
        // best effort
      }
    }
    sseClients.clear();
    for (const w of watchers.values()) {
      w.close().catch(() => {});
    }
    watchers.clear();
    httpServer.close(() => shutdownResolve());
    // Force-close keep-alive sockets so SSE / long-polls don't keep us alive.
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }
  }

  // Idle self-shutdown: the timer only runs while nothing is connected. Any live SSE chrome or
  // active long-poll cancels it; losing the last connection (re)arms it.
  let idleTimer = null;
  function refreshIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (shuttingDown || idleTimeoutMs == null) return;
    if (sseClients.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!shuttingDown && sseClients.size === 0) {
        logEvent?.(`idle for ${idleTimeoutMs}ms with no connections, shutting down`);
        shutdown();
      }
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  // When the last session is deleted with no browser attached there is nothing left to serve,
  // so step down immediately rather than waiting out the idle timeout. If a chrome is still
  // connected, leave the server up and let the idle timer reap it once that drops.
  // Best-effort: never let a read failure block the delete response.
  async function shutdownIfNoLiveSessions() {
    if (sseClients.size > 0) return;
    try {
      if ((await store.listSessions()).length === 0) {
        logEvent?.("last session removed with no live connections, shutting down");
        setImmediate(shutdown);
      }
    } catch {
      // ignore - the idle timer remains as a backstop
    }
  }

  // Arm the idle timer for a server that is spawned but never opens a session.
  refreshIdleTimer();

  return {
    port: httpServer.address().port,
    close: async () => {
      shutdown();
      await done;
    },
    done,
  };
}

async function readDesignAsset(asset) {
  try {
    return await readFile(asset.packaged, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    return readFile(asset.source, "utf8");
  }
}

// Map a legacy root-absolute `/design/<asset>` reference to the packaged design file on disk
// (falling back to the node_modules source for source runs) so an export can inline it instead
// of pointing back at this server's `/design` route.
export function resolveDesignAssetPath(refPath) {
  const match = /^\/design\/([^/?#]+)(?:[?#].*)?$/.exec(refPath);
  if (!match) return null;
  const asset = designAssetUrls[match[1]];
  if (!asset) return null;
  const packaged = fileURLToPath(asset.packaged);
  if (existsSync(packaged)) return packaged;
  const source = fileURLToPath(asset.source);
  return existsSync(source) ? source : null;
}

export function exportContentDisposition(file) {
  const filename = exportFileName(file);
  return `attachment; filename="${sanitizeDispositionFilename(filename)}"; filename*=UTF-8''${encodeRfc5987Value(filename)}`;
}

function sanitizeDispositionFilename(filename) {
  const fallback = Array.from(String(filename || ""), (char) => {
    const codePoint = char.codePointAt(0) || 0;
    if (codePoint < 0x20 || codePoint > 0x7e || char === '"' || char === "\\") return "_";
    return char;
  }).join("");
  return fallback || "artifact.export.html";
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(String(value)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Wildcard bind addresses ("all interfaces") are not connectable hostnames, so
// they never belong in the Host allowlist - and "0.0.0.0" as a Host is a known
// loopback-reach trick, so it must stay rejected.
const WILDCARD_BIND_HOSTS = new Set(["0.0.0.0", "::"]);

// The set of Host header hostnames this server answers to: loopback names plus
// the resolved bind and link host and any explicit LAVISH_AXI_ALLOWED_HOSTS
// extras, minus wildcard binds and the "*" sentinel. Lowercased for
// case-insensitive comparison against the incoming Host.
export function buildAllowedHostnames({ host, linkHost: linkHostName, allowedHosts = [] }) {
  return new Set(
    [LOOPBACK_HOST, IPV6_LOOPBACK_HOST, "localhost", host, linkHostName, ...allowedHosts]
      .map((value) =>
        String(value || "")
          .trim()
          .toLowerCase(),
      )
      .filter((value) => value && value !== "*" && !WILDCARD_BIND_HOSTS.has(value)),
  );
}

// A lone "*" in LAVISH_AXI_ALLOWED_HOSTS is an explicit opt-out of the Host
// allowlist, for operators who front the server with their own auth/proxy.
export function allowsAllHosts(allowedHosts = []) {
  return allowedHosts.some((value) => String(value).trim() === "*");
}

// Extract the hostname (without port) from a Host header value, honoring
// bracketed IPv6 literals ("[::1]:4387"). Returns null for a malformed authority.
export function hostnameFromHostHeader(value) {
  const raw = String(value).trim();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return null;
    // Anything after the closing bracket must be a `:port` suffix; reject trailing
    // garbage (e.g. "[::1]evil.com") instead of reading it as the bracketed host.
    const rest = raw.slice(end + 1);
    if (rest.length > 0 && !rest.startsWith(":")) return null;
    return raw.slice(1, end).toLowerCase();
  }
  const colon = raw.indexOf(":");
  const hostname = colon === -1 ? raw : raw.slice(0, colon);
  // A bare, unbracketed IPv6 literal is not a valid authority; reject it rather
  // than mistaking a hextet for a port.
  if (hostname.includes(":")) return null;
  return hostname.toLowerCase();
}

// DNS-rebinding defense: a loopback-bound server answers only to its own known
// hostnames. A rebound browser carries the attacker's domain in Host and is
// rejected. Host is mandatory in HTTP/1.1 and every browser sends it, so a
// missing or blank value is never a legitimate client - reject it rather than
// fail open.
export function isAllowedHostHeader(hostHeader, allowedHostnames) {
  if (hostHeader === undefined || hostHeader === null) return false;
  const raw = String(hostHeader).trim();
  if (raw === "") return false;
  const hostname = hostnameFromHostHeader(raw);
  if (hostname === null) return false;
  return allowedHostnames.has(hostname);
}

// Validate a request's effective host for DNS-rebinding protection. The Host
// header is required and must be allowlisted. When an X-Forwarded-Host is present
// - a reverse proxy in front of the loopback server - its outermost (last) value
// must ALSO be allowlisted, so a proxy works once its public hostname is added to
// LAVISH_AXI_ALLOWED_HOSTS. This is an AND check: a client-spoofed forwarded host
// can only narrow access (Host is still checked), never widen it into a bypass. A
// blank forwarded host is treated as absent, matching how proxies omit it.
/**
 * @param {{ host?: string|undefined|null, forwardedHost?: string|undefined|null }} headers
 * @param {Set<string>} allowedHostnames
 */
export function isAllowedRequestHost({ host, forwardedHost }, allowedHostnames) {
  if (!isAllowedHostHeader(host, allowedHostnames)) return false;
  const forwarded = forwardedHost === undefined || forwardedHost === null ? "" : String(forwardedHost).trim();
  if (forwarded === "") return true;
  return isAllowedHostHeader(forwarded.split(",").pop(), allowedHostnames);
}

// Guard state-changing, outward-facing routes (publishing to a third-party host) against CSRF: a
// browser attaches an Origin/Referer that must match this server's own origin.
function isSameOriginRequest(req) {
  const expectedOrigin = `${req.protocol}://${req.get("host")}`;
  const origin = req.get("origin");
  if (origin) {
    return normalizeOrigin(origin) === expectedOrigin;
  }
  const referer = req.get("referer");
  return Boolean(referer) && normalizeOrigin(referer) === expectedOrigin;
}

function normalizeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function optionalBodyString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

export function resolveArtifactAsset(root, assetPath) {
  const file = path.resolve(root, assetPath);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

async function watchSession(session, watchers, events, logEvent) {
  if (watchers.has(session.key)) {
    return;
  }
  const target = await resolveWatchTarget(session);
  if (watchers.has(session.key)) {
    return;
  }
  logEvent?.(`watch session=${session.key} scope=${target.scope} path=${target.path}`);
  const watcher = chokidar.watch(target.path, target.options);
  let timer = null;
  watcher.on("all", (event, file) => {
    logEvent?.(`watch event=${event} session=${session.key} file=${file ?? ""}`);
    clearTimeout(timer);
    timer = setTimeout(() => events.emit("reload", session.key), 100);
  });
  watcher.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    logEvent?.(`watch error session=${session.key} message=${message}`);
  });
  watchers.set(session.key, watcher);
}

// Watching the artifact's parent directory recursively can stall the event loop when the
// artifact lives in a large tree (e.g. ~/Downloads). Default to watching only the artifact
// itself; an artifact opts back into directory-wide live reload via either a
// `data-lavish-live-reload-root` attribute on its root element or
// `<meta name="lavish-live-reload" content="root">`.
export async function resolveWatchTarget(session) {
  const baseOptions = {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  };
  try {
    const html = await readFile(session.file, "utf8");
    if (hasLiveReloadRootOptIn(html)) {
      return {
        path: path.dirname(session.file),
        scope: "directory",
        options: {
          ...baseOptions,
          ignored: /(^|[/\\])(\.git|node_modules|dist|build|\.lavish-axi)([/\\]|$)/,
        },
      };
    }
  } catch {
    // Fall through to file-only watching when the artifact can't be read.
  }
  return { path: session.file, scope: "file", options: baseOptions };
}

export function hasLiveReloadRootOptIn(html) {
  if (typeof html !== "string") return false;
  const searchableHtml = html.replace(/<!--[\s\S]*?-->/g, "");
  if (/<html\b[^>]*\sdata-lavish-live-reload-root(?:[\s=>/]|$)[^>]*>/i.test(searchableHtml)) return true;
  return /<meta\b(?=[^>]*name=["']lavish-live-reload["'])(?=[^>]*content=["']root["'])[^>]*>/i.test(searchableHtml);
}

// Validate and canonicalize the render-time layout audit coming back from the browser.
// Only proven severe (error) findings survive; everything else fails open and stays silent.
export function normalizeLayoutWarnings(layoutWarnings) {
  if (!Array.isArray(layoutWarnings)) return [];
  return layoutWarnings
    .filter(
      (warning) =>
        warning &&
        typeof warning === "object" &&
        !Array.isArray(warning) &&
        String(warning.severity || "").toLowerCase() === "error",
    )
    .map((warning) => {
      const axis = warning.axis === "vertical" ? "vertical" : warning.axis === "horizontal" ? "horizontal" : undefined;
      return {
        selector: String(warning.selector || ""),
        kind: String(warning.kind || "layout-failure"),
        ...(axis ? { axis } : {}),
        overflowPx: normalizeFiniteNumber(warning.overflowPx),
        viewportWidth: normalizeFiniteNumber(warning.viewportWidth),
        severity: "error",
      };
    });
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function chromeIcon(paths, size = 16, strokeWidth = 1.7) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const chromeIcons = {
  more: chromeIcon(
    '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  ),
  file: chromeIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    13,
  ),
  copy: chromeIcon(
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    12,
  ),
  check: chromeIcon('<polyline points="20 6 9 17 4 12"/>', 12),
  refresh: chromeIcon(
    '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    15,
  ),
  camera: chromeIcon(
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    15,
  ),
  download: chromeIcon(
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    15,
  ),
  globe: chromeIcon(
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14.5 14.5 0 0 1 0 18a14.5 14.5 0 0 1 0-18z"/>',
    15,
  ),
  exit: chromeIcon(
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    15,
  ),
};

// Display the path with the home directory shortened to "~", split so the directory part can
// ellipsize in the menu while the file name itself always stays visible.
export function displayPathParts(file, home = homedir()) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");
  const display =
    normalizedHome && normalizedFile.startsWith(`${normalizedHome}/`)
      ? `~/${normalizedFile.slice(normalizedHome.length + 1)}`
      : normalizedFile;
  const tailStart = display.lastIndexOf("/") + 1;
  return { head: display.slice(0, tailStart), tail: display.slice(tailStart) };
}

export function shouldEnableLayoutGate(query = {}) {
  const noGate = query["no-gate"] ?? query.noGate ?? query.no_gate;
  if (isTruthyFlag(noGate)) return false;

  const gate = query.gate ?? query.layoutGate ?? query.layout_gate;
  if (isFalseyFlag(gate)) return false;

  return true;
}

function shouldDisableLayoutGateOpen(body = {}) {
  const noGate = body["no-gate"] ?? body.noGate ?? body.no_gate;
  if (isTruthyFlag(noGate)) return true;

  const gate = body.gate ?? body.layoutGate ?? body.layout_gate;
  return isFalseyFlag(gate);
}

function appendNoGateParam(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("no-gate", "1");
  return parsed.toString();
}

function isTruthyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isFalseyFlag(value) {
  const normalized = normalizeFlagValue(value);
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off";
}

function normalizeFlagValue(value) {
  if (Array.isArray(value)) return normalizeFlagValue(value[0]);
  return value === undefined || value === null ? "" : String(value).trim().toLowerCase();
}

const LAVISH_DEFAULT_FAVICON =
  "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F48E}</text></svg>\">";

function readTagAttr(tag, name) {
  // Tokenize real attributes rather than searching for the bare name anywhere in
  // the tag: a `\b`-anchored name matches attribute-name suffixes (e.g. `href`
  // inside `data-href`) and names that appear inside another attribute's quoted
  // value (e.g. `href=` inside a `title="... href=x"`), both of which would make
  // us adopt the wrong href. Walking whole `name="value"` pairs consumes each
  // value as one unit, so only genuine attribute names are matched.
  const attrRe = /([a-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const target = name.toLowerCase();
  let match;
  while ((match = attrRe.exec(tag)) !== null) {
    if (match[1].toLowerCase() === target) {
      return (match[3] ?? match[4] ?? match[5] ?? "").trim();
    }
  }
  return "";
}

// Pull a tab favicon + title out of the artifact's own <head>. Lavish renders the
// artifact in a sandboxed iframe, so the artifact's own <link rel="icon"> and
// <title> never reach the browser tab; surfacing them here makes a wall of Lavish
// tabs identifiable. Falls back to the Lavish default favicon. Only data: and
// absolute (http/https/protocol-relative) icon hrefs are adopted verbatim;
// artifact-relative hrefs would not resolve against the chrome page, so they fall
// back to the default.
export function extractArtifactHead(html) {
  const head = String(html || "").slice(0, 10000);
  let faviconTag = LAVISH_DEFAULT_FAVICON;
  const linkTags = head.match(/<link\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi) || [];
  const iconTag = linkTags.find((tag) => /(^|\s)icon(\s|$)/i.test(readTagAttr(tag, "rel")));
  const iconHref = iconTag ? readTagAttr(iconTag, "href") : "";
  if (iconHref && /^(data:|https?:|\/\/)/i.test(iconHref)) {
    const safeHref = iconHref.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    faviconTag = `<link rel="icon" href="${safeHref}">`;
  }
  let title = "";
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].replace(/\s+/g, " ").trim();
  return { faviconTag, title };
}

// Artifact heads are small; scanning the leading slice keeps a huge artifact from being read
// end-to-end just to label an index card.
const MAX_META_BYTES = 64 * 1024;
const STALE_SESSION_DAYS = 7;

const BASIC_HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

// One pass, so an escaped entity (`&amp;lt;`) decodes to `&lt;` rather than `<`.
function decodeBasicEntities(value) {
  return String(value).replace(/&(amp|lt|gt|quot|#39);/g, (match, name) => BASIC_HTML_ENTITIES[name] ?? match);
}

function collapseMetaText(value) {
  return decodeBasicEntities(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

// The index labels each session with the artifact's own <title> and description rather than a
// file path, so a wall of cards is scannable. Reuses the same attribute tokenizer as
// extractArtifactHead so `data-name=` or a quoted value never masquerades as `name=`.
export function extractArtifactMeta(html) {
  const head = String(html || "").slice(0, MAX_META_BYTES);
  const titleMatch = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTags = head.match(/<meta\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi) || [];
  const descriptionTag = metaTags.find((tag) => readTagAttr(tag, "name").toLowerCase() === "description");
  return {
    title: titleMatch ? collapseMetaText(titleMatch[1]) : "",
    description: descriptionTag ? collapseMetaText(readTagAttr(descriptionTag, "content")) : "",
  };
}

// A session whose artifact was moved or deleted still has state worth showing (and deleting),
// so an unreadable file is a rendered state, not an error.
async function readArtifactMeta(file) {
  try {
    return { ...extractArtifactMeta(await readFile(file, "utf8")), missing: false };
  } catch {
    return { title: "", description: "", missing: true };
  }
}

function entryFileName(entry) {
  return entry?.file ? displayPathParts(String(entry.file), "").tail : "";
}

function entryTitle(entry) {
  return String(entry?.title || entryFileName(entry) || entry?.key || "");
}

function entryTimestamp(entry) {
  return Date.parse(String(entry?.updated_at || entry?.opened_at || ""));
}

// Newest first. Sessions whose timestamps are missing or corrupt sink below every dated one
// instead of sorting as the epoch (which would make them look freshly touched).
export function sortEntriesByRecency(entries) {
  return [...(Array.isArray(entries) ? entries : [])].sort((a, b) => {
    const aTime = entryTimestamp(a);
    const bTime = entryTimestamp(b);
    const aDated = Number.isFinite(aTime);
    const bDated = Number.isFinite(bTime);
    if (aDated !== bDated) return aDated ? -1 : 1;
    if (aDated && bDated && aTime !== bTime) return bTime - aTime;
    return entryTitle(a).localeCompare(entryTitle(b));
  });
}

function indexCard(entry, { home, recent }) {
  const key = String(entry?.key || "");
  const title = entryTitle(entry);
  const { tail } = displayPathParts(String(entry?.file || ""), home);
  const missing = Boolean(entry?.missing);
  const description = String(entry?.description || "");
  // Only the recent view carries data-updated-at; its presence is what tells the client script
  // to label the age line "updated". data-opened-at is always present because the 7-day prune
  // measures age from first open in both views.
  const updatedAttr = recent ? ` data-updated-at="${escapeHtml(String(entry?.updated_at || ""))}"` : "";
  return `<article class="card${missing ? " is-missing" : ""}" data-key="${escapeHtml(key)}" data-opened-at="${escapeHtml(String(entry?.opened_at || ""))}"${updatedAttr}>
<a class="card-open" href="${escapeHtml(String(entry?.url || ""))}">
<div class="card-top"><h3 class="card-title">${escapeHtml(title)}</h3>${missing ? '<span class="badge badge-missing">missing</span>' : ""}</div>
${description ? `<p class="card-desc">${escapeHtml(description)}</p>` : ""}
<p class="card-file">${escapeHtml(tail)}</p>
<p class="card-age"><span class="age-label">${recent ? "updated" : "opened"}</span> <span class="age-value">recently</span></p>
</a>
<button class="card-delete" type="button" data-delete-key="${escapeHtml(key)}" data-delete-title="${escapeHtml(title)}">Delete</button>
</article>`;
}

function folderSections(entries, home) {
  const groups = new Map();
  for (const entry of entries) {
    const { head } = displayPathParts(String(entry?.file || ""), home);
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(entry);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, groupEntries]) => {
      const sorted = [...groupEntries].sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)));
      const keys = sorted.map((entry) => String(entry?.key || "")).join(" ");
      return `<section class="group" data-group data-keys="${escapeHtml(keys)}" data-dir="${escapeHtml(dir)}">
<header class="group-head"><h2 class="group-dir">${escapeHtml(dir)}</h2><span class="group-count">${sorted.length}</span><button class="group-delete" type="button" data-delete-group>Delete all</button></header>
<div class="cards">${sorted.map((entry) => indexCard(entry, { home, recent: false })).join("")}</div>
</section>`;
    })
    .join("");
}

const INDEX_CSS = `
:root { color-scheme: light dark; --bg: #f6f6f4; --panel: #ffffff; --ink: #1b1b19; --muted: #6b6b64; --line: #e2e2dc; --accent: #1f6feb; --danger: #b42318; }
@media (prefers-color-scheme: dark) { :root { --bg: #131312; --panel: #1c1c1a; --ink: #ededea; --muted: #9a9a92; --line: #2e2e2a; --accent: #6da2ff; --danger: #ff6b5e; } }
* { box-sizing: border-box; }
body.lavish-index { margin: 0; padding: 32px clamp(16px, 5vw, 56px) 64px; background: var(--bg); color: var(--ink); font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
.page-head { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
.page-head h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
.page-count { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.page-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.toggle { display: inline-flex; padding: 3px; gap: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.toggle-option { padding: 5px 14px; border-radius: 999px; color: var(--muted); font-size: 13px; text-decoration: none; }
.toggle-option.is-active { background: var(--ink); color: var(--bg); }
.prune { padding: 7px 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--danger); font: inherit; font-size: 13px; cursor: pointer; }
.prune[disabled] { color: var(--muted); cursor: default; opacity: 0.6; }
.page-body { padding-top: 24px; }
.group { margin-bottom: 32px; }
.group-head { display: flex; gap: 10px; align-items: baseline; margin-bottom: 12px; }
.group-dir { margin: 0; min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.group-count { padding: 1px 8px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); color: var(--muted); font-size: 11px; }
.group-delete { margin-left: auto; border: 0; background: none; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
.group-delete:hover { color: var(--danger); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 12px; }
.card { position: relative; display: flex; min-width: 0; flex-direction: column; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
.card.is-missing { opacity: 0.72; }
.card-open { display: block; min-width: 0; padding: 16px 16px 14px; color: inherit; text-decoration: none; }
.card-top { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.card-title { margin: 0; min-width: 0; flex: 1 1 auto; overflow-wrap: anywhere; font-size: 15px; font-weight: 600; }
.badge { flex: 0 0 auto; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 11px; letter-spacing: 0.02em; text-transform: lowercase; color: var(--muted); }
.badge-missing { color: var(--danger); border-color: currentColor; }
.card-desc { margin: 8px 0 0; overflow-wrap: anywhere; color: var(--muted); font-size: 13px; }
.card-file { margin: 10px 0 0; overflow-wrap: anywhere; color: var(--muted); font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.card-age { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.card-delete { margin: 0 12px 12px auto; border: 0; background: none; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
.card-delete:hover { color: var(--danger); }
.empty { padding: 48px 0; text-align: center; }
.empty-title { margin: 0; font-size: 17px; font-weight: 600; }
.empty-copy { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
.empty code { padding: 2px 6px; border-radius: 6px; background: var(--panel); border: 1px solid var(--line); font-size: 12px; }
`;

// Deletes are irreversible and remove the artifact file itself, so every path confirms first.
const INDEX_SCRIPT = `
(function () {
  var STALE_MS = ${STALE_SESSION_DAYS} * 24 * 60 * 60 * 1000;
  var pruneButton = document.getElementById("pruneStale");
  var countLabel = document.getElementById("sessionCount");

  function cards() {
    return Array.prototype.slice.call(document.querySelectorAll(".card[data-key]"));
  }

  function relativeTime(iso) {
    var at = Date.parse(iso || "");
    if (!isFinite(at)) return "";
    var minutes = Math.floor(Math.max(0, Date.now() - at) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  }

  function paintAges() {
    cards().forEach(function (card) {
      var updatedAt = card.getAttribute("data-updated-at");
      var relative = relativeTime(updatedAt || card.getAttribute("data-opened-at"));
      var label = card.querySelector(".age-label");
      var value = card.querySelector(".age-value");
      if (label) label.textContent = updatedAt ? "updated" : "opened";
      if (value) value.textContent = relative || "at an unknown time";
    });
  }

  function staleCards() {
    var cutoff = Date.now() - STALE_MS;
    return cards().filter(function (card) {
      var openedAt = Date.parse(card.getAttribute("data-opened-at") || "");
      return isFinite(openedAt) && openedAt < cutoff;
    });
  }

  function refresh() {
    paintAges();
    var total = cards().length;
    if (countLabel) countLabel.textContent = total + (total === 1 ? " session" : " sessions") + " on this machine";
    if (!pruneButton) return;
    var stale = staleCards().length;
    pruneButton.textContent = stale > 0 ? "Delete not opened in 7d (" + stale + ")" : "Delete not opened in 7d";
    pruneButton.disabled = stale === 0;
  }

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (res) {
      if (!res.ok) throw new Error("Request failed with status " + res.status);
      return res.json();
    });
  }

  function dropCards(list) {
    list.forEach(function (card) {
      var group = card.closest("[data-group]");
      card.remove();
      if (group && !group.querySelector(".card[data-key]")) group.remove();
    });
    refresh();
  }

  function failed(error) {
    window.alert("Could not delete: " + (error && error.message ? error.message : String(error)));
  }

  function keysOf(list) {
    return list.map(function (card) {
      return card.getAttribute("data-key");
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;

    var deleteButton = target.closest("[data-delete-key]");
    if (deleteButton) {
      var card = deleteButton.closest(".card[data-key]");
      var title = deleteButton.getAttribute("data-delete-title") || "this session";
      if (!window.confirm("Delete " + title + "?\\n\\nThis permanently deletes the session AND its artifact HTML file from disk. It cannot be undone."))
        return;
      deleteButton.disabled = true;
      postJson("/api/" + encodeURIComponent(deleteButton.getAttribute("data-delete-key")) + "/delete")
        .then(function () {
          if (card) dropCards([card]);
        })
        .catch(function (error) {
          deleteButton.disabled = false;
          failed(error);
        });
      return;
    }

    var groupButton = target.closest("[data-delete-group]");
    if (groupButton) {
      var group = groupButton.closest("[data-group]");
      if (!group) return;
      var groupCards = Array.prototype.slice.call(group.querySelectorAll(".card[data-key]"));
      if (groupCards.length === 0) return;
      if (
        !window.confirm(
          "Delete all " +
            groupCards.length +
            " session(s) in " +
            (group.getAttribute("data-dir") || "this folder") +
            "?\\n\\nThis permanently deletes each session AND its artifact HTML file from disk. It cannot be undone.",
        )
      )
        return;
      groupButton.disabled = true;
      postJson("/api/batch-delete", { keys: keysOf(groupCards) })
        .then(function () {
          dropCards(groupCards);
        })
        .catch(function (error) {
          groupButton.disabled = false;
          failed(error);
        });
    }
  });

  if (pruneButton) {
    pruneButton.addEventListener("click", function () {
      var stale = staleCards();
      if (stale.length === 0) return;
      if (
        !window.confirm(
          "Delete " +
            stale.length +
            " session(s) not opened in the last 7 days?\\n\\nThis permanently deletes each session AND its artifact HTML file from disk. It cannot be undone.",
        )
      )
        return;
      pruneButton.disabled = true;
      postJson("/api/batch-delete", { keys: keysOf(stale) })
        .then(function () {
          dropCards(stale);
        })
        .catch(function (error) {
          failed(error);
          refresh();
        });
    });
  }

  refresh();
  setInterval(paintAges, 60000);
})();
`;

export function createIndexHtml(entries, { home = homedir(), sort = "folder" } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const recent = sort === "recent";
  const count = list.length;
  const body =
    count === 0
      ? '<div class="empty"><p class="empty-title">No sessions yet.</p><p class="empty-copy">Run <code>lavish-axi &lt;html-file&gt;</code> to open an artifact for review.</p></div>'
      : recent
        ? `<section class="group" data-group data-keys="${escapeHtml(
            sortEntriesByRecency(list)
              .map((entry) => String(entry?.key || ""))
              .join(" "),
          )}"><div class="cards">${sortEntriesByRecency(list)
            .map((entry) => indexCard(entry, { home, recent: true }))
            .join("")}</div></section>`
        : folderSections(list, home);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish sessions</title>
${LAVISH_DEFAULT_FAVICON}
<style>${INDEX_CSS}</style>
</head>
<body class="lavish-index">
<header class="page-head">
<div class="page-titles"><h1>Lavish sessions</h1><p class="page-count" id="sessionCount">${count} session${count === 1 ? "" : "s"} on this machine</p></div>
<div class="page-actions">
<nav class="toggle" aria-label="Sort sessions"><a class="toggle-option${recent ? "" : " is-active"}" href="/session"${recent ? "" : ' aria-current="page"'}>By folder</a><a class="toggle-option${recent ? " is-active" : ""}" href="/session?sort=recent"${recent ? ' aria-current="page"' : ""}>Recent</a></nav>
<button class="prune" id="pruneStale" type="button" disabled>Delete not opened in 7d</button>
</div>
</header>
<main class="page-body" id="sessionList">${body}</main>
<script>${INDEX_SCRIPT}</script>
</body>
</html>`;
}

export function createChromeHtml(
  session,
  { layoutGateEnabled = true, faviconTag = LAVISH_DEFAULT_FAVICON, title = "Lavish" } = {},
) {
  const sessionJson = jsonScript({
    key: session.key,
    file: session.file,
    layoutGateEnabled,
  });
  const { head: pathHead, tail: pathTail } = displayPathParts(session.file);
  const bodyClass = layoutGateEnabled ? "lavish layout-gate-active" : "lavish";
  const layoutGateHidden = layoutGateEnabled ? "" : " hidden";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${faviconTag}
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="${bodyClass}">
<div class="bar"><div class="brand"><span class="brand-mark">Lavish</span></div><div class="spacer" aria-hidden="true"></div><div class="more-wrap" id="moreWrap"><button class="more-button" id="moreButton" type="button" title="More" aria-haspopup="menu" aria-expanded="false">${chromeIcons.more}</button><div class="menu more-menu" id="moreMenu" hidden><div class="menu-head"><div class="menu-label">Artifact</div><button class="menu-file" id="copyPath" type="button" title="Copy path · ${escapeHtml(session.file)}">${chromeIcons.file}<span class="menu-file-text"><span class="path-head">${escapeHtml(pathHead)}</span><span class="path-tail">${escapeHtml(pathTail)}</span></span><span class="copy-hint" id="copyHint"><span class="icon-copy">${chromeIcons.copy}</span><span class="icon-check">${chromeIcons.check}</span><span id="copyHintText">Copy</span></span></button></div><div class="menu-rule"></div><button class="menu-item" id="reloadArtifact" type="button">${chromeIcons.refresh}<span>Reload artifact</span></button><button class="menu-item" id="exportArtifact" type="button">${chromeIcons.download}<span>Export standalone HTML</span></button><button class="menu-item" id="shareArtifact" type="button">${chromeIcons.globe}<span>Publish link</span></button></div></div></div>
<div class="layout"><div class="frame"><iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads" data-artifact-src="/artifact/${session.key}/index.html"></iframe><div class="layout-issue-banner" id="layoutIssueBanner" hidden>This surface has a severe layout failure.</div></div></div>
<div class="share-overlay" id="shareDialog" role="dialog" aria-modal="true" aria-labelledby="shareTitleText" hidden><form class="share-card" id="shareForm"><div class="share-head"><div><div class="share-kicker">Publish to <a class="share-link" href="https://ht-ml.app" target="_blank" rel="noopener noreferrer">ht-ml.app</a></div><h2 id="shareTitleText">Publish artifact</h2></div><button class="share-close" id="shareClose" type="button" aria-label="Close publish dialog"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div><p class="share-note">ht-ml.app is a separate, third-party hosting service, not part of Lavish. Publishing sends this artifact to its servers.</p><p class="share-copy">This uploads this artifact to ht-ml.app with local assets inlined. Without a password, the page is PUBLIC and anyone with the link can open it. With a password, the page is PRIVATE and viewers must supply the password to view.</p><p class="share-note">Do not publish secrets. The Lavish annotation SDK is not included.</p><div class="share-grid"><label>Password (optional)<input id="sharePassword" name="password" type="password" autocomplete="new-password" placeholder="Leave blank for a public page"></label></div><div class="share-status" id="shareStatus" role="status"></div><div class="share-result" id="shareResult" hidden><label>Share URL<div class="share-copy-row"><input id="shareUrl" readonly><button class="share-copy-btn" id="copyShareUrl" type="button">Copy URL</button></div></label><label>Update key (secret)<div class="share-copy-row"><input id="shareUpdateKey" readonly><button class="share-copy-btn" id="copyUpdateKey" type="button">Copy key</button></div></label><p class="share-note">Keep the update key private. ht-ml.app returns it once and it is the only way to update or delete this page later.</p></div><div class="share-actions"><button class="share-cancel" id="shareCancel" type="button">Cancel</button><button class="button" id="sharePublish" type="submit">Publish</button></div></form></div>
<div class="curtain layout-gate-overlay" id="layoutGateOverlay"${layoutGateHidden}><div class="curtain-card"><div class="curtain-title" id="layoutGateTitle">Checking layout.<br>One moment.</div><p class="curtain-copy" id="layoutGateCopy">Lavish is waiting for fonts and final geometry before revealing this artifact.</p><button class="button curtain-action" id="layoutGateAction" type="button">Show anyway</button></div></div>
<div class="whiteboard-overlay" id="whiteboardOverlay" hidden><div class="whiteboard-shell"><div class="whiteboard-error" id="whiteboardError" hidden></div><button class="whiteboard-close" id="whiteboardClose" type="button" aria-label="Close whiteboard"><svg width="14" height="14" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button><iframe id="whiteboardFrame" title="Excalidraw whiteboard" sandbox="allow-scripts allow-popups"></iframe></div></div>
<script id="lavish-session" type="application/json">${sessionJson}</script>
<script src="/chrome-client.js"></script>
</body>
</html>`;
}

export function createWhiteboardFrameHtml(channelToken = "") {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lavish Diagram</title>
<link rel="stylesheet" href="/whiteboard-assets/whiteboard.css">
</head>
<body>
<script>window.__lavishWhiteboardChannelToken=${JSON.stringify(channelToken)};</script>
<script src="/whiteboard-assets/whiteboard.js"></script>
</body>
</html>`;
}

export function createSdkJs(key) {
  // Serialize every helper exported by mermaid-node.js as a same-scope const so
  // cross-helper calls resolve in the browser. Deriving this from the module's
  // exports — rather than a hand-kept list — means adding a helper can never
  // silently ReferenceError at runtime.
  const mermaidHelperEntries = Object.entries(mermaidNode).filter(([, value]) => typeof value === "function");
  const mermaidHelperDecls = mermaidHelperEntries.map(([name, fn]) => `const ${name}=${fn.toString()};`).join("\n");
  const mermaidHelperKeys = mermaidHelperEntries.map(([name]) => name).join(", ");
  return `(() => {
const key=${JSON.stringify(key)};
void key;
const classifySevereTextOverflow=${classifySevereTextOverflow.toString()};
const classifyMaterialRectEscape=${classifyMaterialRectEscape.toString()};
const isMaterialPageOverflow=${isMaterialPageOverflow.toString()};
const findStableLayoutFindings=${findStableLayoutFindings.toString()};
const isNearTotalOcclusion=${isNearTotalOcclusion.toString()};
${mermaidHelperDecls}
const mermaidHelpers={ ${mermaidHelperKeys} };
(${createArtifactSdk.toString()})(mermaidHelpers);
})();`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
