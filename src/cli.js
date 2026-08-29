import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AxiError, installSessionStartHooks, RESERVED_COMMANDS, runAxiCli } from "axi-sdk-js";

import { createDesignOutput, DESIGN_PRIORITY_RULE, DESIGN_SYSTEM_HINT } from "./design-reference.js";
import {
  buildSelfContainedHtml,
  exportFileName,
  exportWarningSummaries,
  splitExportWarnings,
} from "./export-bundle.js";
import { publishToHtmlApp } from "./html-app.js";
import { clientHost, defaultPort, ensureStateDir, hostForUrl, serverLogFile, stateFile } from "./paths.js";
import { findPlaybook, listPlaybooks, playbookIds, PLAYBOOK_ROUTER_HELP } from "./playbooks.js";
import { resolveDesignAssetPath, serve } from "./server.js";
import { canonicalFile, sessionKey, SessionStore } from "./session-store.js";
import { initDefaultTelemetry } from "./telemetry.js";

const COMMANDS = new Set(["open", "stop", "server", "playbook", "design", "setup", "export", "share"]);
// SDK-reserved built-ins (e.g. `update`) must reach runAxiCli untouched; otherwise
// the bare-arg normalization below would rewrite them into the hidden `open` command.
const RESERVED = new Set(RESERVED_COMMANDS);
const DESCRIPTION =
  "Lavish turns an agent's complex or visual response into a rich HTML page displayed in the user's browser. Whenever you are about to give the user a response that is easier to understand as a page than as prose, build the page and show it with Lavish. " +
  "Generate an interactive HTML artifact, then run `lavish-axi <html-file>` to display it. That command returns immediately - Lavish is a display surface, not a feedback channel, so continue the conversation here once the page is open.";
// Inlined at build time from package.json; falls back to reading package.json so source-run tests work.
export const VERSION =
  process.env.LAVISH_AXI_BUILD_VERSION ||
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export async function run(argv) {
  await ensureStateDir();
  const normalizedArgv = normalizeArgv(argv);
  const isTopLevelHelp = argv.length === 1 && argv[0] === "--help";
  const command = telemetryCommandName(argv);
  const telemetry = initDefaultTelemetry({
    app: "lavish-axi",
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
  });
  telemetry.pageview(`/${command}`, { command });
  try {
    await runAxiCli({
      description: DESCRIPTION,
      version: VERSION,
      argv: isTopLevelHelp ? [] : normalizedArgv,
      topLevelHelp: createTopLevelHelp(),
      home: async () =>
        createHomeOutput({
          bin: process.argv[1] || "lavish-axi",
          sessions: isTopLevelHelp ? [] : await listOpenSessions(),
          includeSessions: !isTopLevelHelp,
        }),
      commands: {
        open: openCommand,
        stop: stopCommand,
        playbook: playbookCommand,
        design: designCommand,
        setup: setupCommand,
        server: serverCommand,
        export: exportCommand,
        share: shareCommand,
      },
      getCommandHelp,
    });
    telemetry.track("command", { command, status: "success" });
  } catch (error) {
    telemetry.track("command", { command, status: "error" });
    throw error;
  } finally {
    await telemetry.close(1_000);
  }
}

export function collapseHomeDirectory(file, home) {
  const normalizedFile = file.replaceAll("\\", "/");
  const normalizedHome = home.replaceAll("\\", "/");

  if (normalizedFile === normalizedHome) {
    return "~";
  }
  if (normalizedFile.startsWith(`${normalizedHome}/`)) {
    return `~/${normalizedFile.slice(normalizedHome.length + 1)}`;
  }
  return file;
}

export function normalizeArgv(argv) {
  const first = argv[0];
  if (!first || COMMANDS.has(first) || RESERVED.has(first)) {
    return argv;
  }
  if (first.startsWith("-")) {
    return argv.some((arg) => isHtmlPath(arg)) ? ["open", ...argv] : argv;
  }
  return ["open", ...argv];
}

export function telemetryCommandName(argv) {
  const normalized = normalizeArgv(argv);
  return normalized[0] && !normalized[0].startsWith("-") ? normalized[0] : "home";
}

export function createHomeOutput({ bin, sessions, includeSessions = true }) {
  return {
    bin: collapseHomeDirectory(bin, os.homedir()),
    description: DESCRIPTION,
    ...(includeSessions
      ? {
          sessions: sessions.map((session) => ({
            file: session.file,
            url: session.url,
          })),
        }
      : {}),
    visual_guidance: [
      "Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance",
      "Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose",
      "Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view",
      "Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately",
      "When the artifact would describe existing or current UI or state, show it instead: capture screenshots of the real pages (run the app read-only if needed) and embed them, rather than explaining the current look in prose; reserve prose for what cannot be shown such as rationale, trade-offs, and open questions",
    ],
    playbooks: listPlaybooks(),
    help: [
      "Run `lavish-axi <html-file>` to display an artifact in the user's browser. It opens (or refreshes) the page and returns right away - there is nothing to poll, subscribe to, or wait for. Tell the user the page is open and keep talking to them in this conversation; they will respond to you here, not in the browser",
      "Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`",
      "Lavish serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work",
      "Before returning, `lavish-axi <html-file>` waits a few seconds for the real browser's render-time layout audit and includes any proven severe layout failures as `layout_warnings`. Repair every returned failure and re-run the command to re-check before telling the user the page is ready. Cosmetic, intentional, transient, tiny, and uncertain observations never appear; an absent audit reports no findings rather than a defect",
      "Editing the artifact file live-reloads the open page, so iterating on it needs no extra command - the browser updates itself and keeps its scroll position",
      "Rendered Mermaid diagrams in `.mermaid` containers are displayed as formally styled Excalidraw drawings in the browser (a Fullscreen action opens one over the whole viewport); flowchart, sequence, class, ER, and state diagrams convert to shapes, other types render as an image. They are view-only - the Mermaid source in the artifact stays the single representation of the diagram, and standalone or exported copies render plain Mermaid",
      "Run `lavish-axi export <html-file> [--out <path>]` to write a portable copy of the artifact - one HTML file with its LOCAL assets inlined - so it opens with no Lavish server and no sibling files. Remote CDN/font references are left as links, so it needs network to render those. Users can also export from the browser chrome's overflow menu",
      "Run `lavish-axi share <html-file> [--password <pw>] [--token <t>]` to publish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Lavish, and get back a visitable URL. Shares are PUBLIC by default, so anyone with the link can open them. Pass --password to publish a PRIVATE password-protected page; viewers must supply the password to view. Local assets are inlined; remote refs load over the network. It returns the url plus a secret update_key for managing the page later. Use --token or LAVISH_AXI_HTML_APP_TOKEN only when you have an optional bearer token; it is never required. Users can also publish from the browser chrome's overflow menu",
      "Run `lavish-axi stop` to shut down the background server (it also self-stops when no browser has been connected for a while). Closing the browser tab is how a user is done with an artifact; there is no session to end",
      `Run \`lavish-axi playbook <playbook_id>\` for focused artifact guidance. ${PLAYBOOK_ROUTER_HELP}`,
      DESIGN_SYSTEM_HINT,
      "Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, product or technical plan, comparison, report, diagram, or anything easier to grasp as a page than as prose",
    ],
  };
}

export function createPlaybookOutput(args) {
  const id = args[0];
  if (!id) {
    return {
      playbooks: listPlaybooks(),
      help: ["Run `lavish-axi playbook <playbook_id>` for focused artifact guidance", PLAYBOOK_ROUTER_HELP],
    };
  }

  const playbook = findPlaybook(id);
  if (!playbook) {
    throw new AxiError(`Unknown playbook: ${id}`, "VALIDATION_ERROR", [
      `Run \`lavish-axi playbook\` to list known IDs: ${playbookIds().join(", ")}`,
    ]);
  }

  return { playbook };
}

/**
 * @param {{ file: string, url: string, status: string, layoutWarnings?: any[] }} params
 * @returns {{ session: { file: string, url: string, status: string }, layout_warnings?: any[], next_step: string }}
 */
export function createOpenOutput({ file, url, status, layoutWarnings = [] }) {
  const warnings = Array.isArray(layoutWarnings)
    ? layoutWarnings.filter((warning) => warning && String(warning.severity || "").toLowerCase() === "error")
    : [];
  return {
    session: { file, url, status },
    ...(warnings.length > 0 ? { layout_warnings: warnings } : {}),
    next_step:
      warnings.length > 0
        ? `${warnings.length} proven severe layout failure${warnings.length === 1 ? "" : "s"} - the real browser reports that meaningful content or a required control in ${file} is inaccessible or unusable. Repair it, then run \`lavish-axi ${file}\` again to re-check the audit before telling the user the page is ready.`
        : `${file} is displayed at ${url}. Lavish is a display surface, not a feedback channel: nothing is running, there is nothing to poll or wait for, and the user will reply to you in this conversation rather than in the browser. Tell them the page is open, summarize what it shows, and continue here. Editing the file live-reloads the open page, so you can iterate without re-running this command.`,
  };
}

async function openCommand(args) {
  const file = firstPositionalArg(args);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `lavish-axi <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const noGate = args.includes("--no-gate");
  const baseUrl = await ensureServer({ forceRestart: shouldForceRestartForLocalBuild(process.argv[1] || "") });
  const response = await postJson(`${baseUrl}/api/sessions`, { file: absolute, noGate });
  let opened = false;
  if (shouldOpenBrowser(args, process.env)) {
    try {
      const open = (await import("open")).default;
      await open(response.url);
      opened = true;
    } catch {
      response.status = "ready";
    }
  }
  // Only a page that is actually loading can produce an audit, so skip the wait entirely when
  // no browser was launched - otherwise every --no-open call would stall for the full budget.
  const layoutWarnings = opened
    ? await waitForLayoutAudit(baseUrl, response.key || sessionKey(absolute), layoutAuditWaitMs(process.env))
    : [];
  return createOpenOutput({
    file: absolute,
    url: response.url,
    status: response.status || "opened",
    layoutWarnings,
  });
}

// How long to wait for the browser's verdict before returning anyway. Set
// LAVISH_AXI_LAYOUT_AUDIT_WAIT_MS to 0/off to return as soon as the page is opened.
export function layoutAuditWaitMs(env = process.env) {
  const raw = env.LAVISH_AXI_LAYOUT_AUDIT_WAIT_MS?.trim();
  if (raw === undefined || raw === "") return null;
  if (raw === "0" || raw.toLowerCase() === "off") return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Best effort by design: an audit that does not arrive is uncertainty, not evidence of a
// defect, so a timeout or a failed request reports no findings rather than failing the open.
async function waitForLayoutAudit(baseUrl, key, timeoutMs) {
  if (timeoutMs === 0) return [];
  const query = timeoutMs === null ? "" : `?timeoutMs=${encodeURIComponent(String(timeoutMs))}`;
  try {
    const response = await fetchJson(`${baseUrl}/api/${key}/layout-audit${query}`);
    return Array.isArray(response.layout_warnings) ? response.layout_warnings : [];
  } catch {
    return [];
  }
}

export function shouldOpenBrowser(args, env) {
  return !args.includes("--no-open") && env.LAVISH_AXI_NO_OPEN !== "1";
}

// Produce a portable copy of an artifact: one HTML file with its LOCAL assets (relative-path
// stylesheets, scripts, images, fonts) inlined as data URIs. Remote CDN/font references are left
// as-is for the browser to load, so the export needs network to render those. Lavish makes no
// outbound requests - export is a pure local file transform, server-independent.
async function exportCommand(args) {
  const file = firstPositionalArg(args, ["--out"]);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `lavish-axi export <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const root = path.dirname(absolute);
  const output = path.resolve(flagValue(args, "--out") || path.join(root, exportFileName(absolute)));
  const source = await readFile(absolute, "utf8");
  const { html, warnings } = await buildSelfContainedHtml(source, {
    baseDir: root,
    confineDir: root,
    resolveAbsolute: resolveDesignAssetPath,
  });
  await writeFile(output, html);
  return createExportOutput({ source: absolute, output, html, warnings });
}

export function createExportOutput({ source, output, html, warnings }) {
  const allWarnings = Array.isArray(warnings) ? warnings : [];
  const { unresolved, notices } = splitExportWarnings(allWarnings);
  const result = {
    export: {
      source,
      output,
      bytes: Buffer.byteLength(html),
      unresolved_local_assets: unresolved.length,
      notices: notices.length,
    },
  };
  if (allWarnings.length) result.warnings = exportWarningSummaries(allWarnings);
  if (unresolved.length) result.unresolved_local_assets = exportWarningSummaries(unresolved);
  if (notices.length) result.notices = exportWarningSummaries(notices);
  if (unresolved.length) {
    result.next_step =
      "Some LOCAL assets could not be inlined and were left as references (see unresolved_local_assets); they will break once the file is moved. Remote CDN/font references are intentionally left as links and render where there is network access.";
  } else if (notices.length) {
    result.next_step = `Wrote ${output} with export notices (see notices). Open it directly or host it anywhere - it needs no Lavish server. Local assets are inlined; remote CDN/font references are left as links, so it needs network to render those.`;
  } else {
    result.next_step = `Wrote ${output}. Open it directly or host it anywhere - it needs no Lavish server. Local assets are inlined; remote CDN/font references are left as links, so it needs network to render those.`;
  }
  return result;
}

function assetWarningSummaries(warnings) {
  return exportWarningSummaries(warnings);
}

// Publish the artifact as a visitable page on third-party ht-ml.app. Builds the same local-inlined
// HTML as `export` (remote refs left as links), then POSTs it to ht-ml.app's `/v1/sites` API,
// sending the artifact to ht-ml.app's servers. The service is not part of Lavish, needs no
// account or API key, and returns the share URL plus the secret update_key for
// managing the page later. Server-independent.
async function shareCommand(args) {
  const file = firstPositionalArg(args, ["--password", "--token"]);
  if (!file) {
    throw new AxiError("HTML file path is required", "VALIDATION_ERROR", ["Run `lavish-axi share <html-file>`"]);
  }
  await assertHtmlFile(file);
  const absolute = await canonicalFile(file);
  const password = optionalFlagString(flagValue(args, "--password"));
  const token = optionalFlagString(flagValue(args, "--token"));
  const root = path.dirname(absolute);
  const source = await readFile(absolute, "utf8");
  const { html, warnings } = await buildSelfContainedHtml(source, {
    baseDir: root,
    confineDir: root,
    resolveAbsolute: resolveDesignAssetPath,
  });
  const site = await publishToHtmlApp(html, { password, token });
  return createShareOutput({ source: absolute, site, warnings, passwordProtected: Boolean(password) });
}

export function createShareOutput({ source, site, warnings, passwordProtected = false }) {
  const allWarnings = Array.isArray(warnings) ? warnings : [];
  const { unresolved, notices } = splitExportWarnings(allWarnings);
  const isPasswordProtected = Boolean(passwordProtected);
  const result = {
    share: {
      source,
      url: site.url,
      site_id: site.site_id,
      update_key: site.update_key,
      status: site.status || "active",
      public: !isPasswordProtected,
      visibility: isPasswordProtected ? "private" : "public",
      password_protected: isPasswordProtected,
      unresolved_local_assets: unresolved.length,
      notices: notices.length,
    },
  };
  const passwordNote = isPasswordProtected ? " This page is PASSWORD-PROTECTED; viewers also need the password." : "";
  if (allWarnings.length) result.warnings = exportWarningSummaries(allWarnings);
  if (unresolved.length) result.unresolved_local_assets = assetWarningSummaries(unresolved);
  if (notices.length) result.notices = assetWarningSummaries(notices);
  const noticeNote = notices.length ? " Export notices are available in notices." : "";
  const hostNote =
    "ht-ml.app (https://ht-ml.app), a third-party host not part of Lavish, hosts the page, so it needs no Lavish server.";
  if (unresolved.length) {
    result.next_step =
      `Published ${isPasswordProtected ? "a PASSWORD-PROTECTED page at " : ""}${site.url}, but some LOCAL assets could not be inlined and were left as references (see unresolved_local_assets); inspect the hosted page and fix missing local assets before sharing it.${passwordNote}${noticeNote} ` +
      `Remote CDN/font references are intentionally left as links and render where there is network access. ` +
      `The update_key is a secret shown only once; keep it to update or delete the page later (there is no recovery). ` +
      hostNote;
  } else if (isPasswordProtected) {
    result.next_step =
      `Published a PASSWORD-PROTECTED page: ${site.url} - share this URL with the user and provide the password separately; viewers also need the password. ` +
      `${noticeNote ? `${noticeNote} ` : ""}` +
      `The update_key is a secret shown only once; keep it to update or delete the page later (there is no recovery). ` +
      hostNote;
  } else {
    result.next_step =
      `Published a PUBLIC page that anyone with the link can view: ${site.url} - share this URL with the user. ` +
      `${noticeNote ? `${noticeNote} ` : ""}` +
      `The update_key is a secret shown only once; keep it to update or delete the page later (there is no recovery). ` +
      hostNote;
  }
  return result;
}

// Explicitly shut down the running Lavish Editor server. Unlike `end` (which closes a single
// session), this stops the background process so it stops dangling between sessions.
export async function stopCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  return shutdownServerOnPort(port, { baseUrl, currentVersion: VERSION });
}

export async function shutdownServerOnPort(
  port,
  {
    baseUrl = `http://${hostForUrl(clientHost())}:${port}`,
    currentVersion = VERSION,
    fetchHealth: healthFetcher = fetchHealth,
    requestShutdown: shutdownRequester = requestShutdown,
    waitForPortFree: portFreeWaiter = waitForPortFree,
    killProcessOnPort: portKiller = killProcessOnPort,
    processMatchesLavish = processOnPortMatchesLavish,
  } = {},
) {
  const health = await healthFetcher(baseUrl);
  if (!health) {
    return { server: { status: "not-running", port } };
  }
  if (!(await canControlServerOnPort(port, health, processMatchesLavish))) {
    return { server: { status: "not-lavish", port } };
  }
  await shutdownRequester(baseUrl);
  let freed = await portFreeWaiter(baseUrl, 3000);
  if (!freed && shouldKillProcessOnPort(currentVersion, health)) {
    portKiller(port);
    freed = await portFreeWaiter(baseUrl, 3000);
  }
  return { server: { status: freed ? "stopped" : "stopping", port } };
}

async function playbookCommand(args) {
  return createPlaybookOutput(args);
}

async function designCommand() {
  return createDesignOutput();
}

async function setupCommand(args) {
  if (args.length !== 1 || args[0] !== "hooks") {
    throw new AxiError("Unknown setup action", "VALIDATION_ERROR", ["Run `lavish-axi setup hooks`"]);
  }

  const errors = [];
  installSessionStartHooks({
    marker: "lavish-axi",
    binaryNames: ["lavish-axi"],
    distEntrypoints: ["dist/cli.mjs", "bin/lavish-axi.js"],
    homeDir: resolveHookHomeDir(),
    onError: (message) => errors.push(message),
  });
  installCopilotCliSessionStartHook({
    hookDir: resolveCopilotHookDir(process.env, resolveHookHomeDir()),
    onError: (message) => errors.push(message),
  });

  if (errors.length > 0) {
    throw new AxiError("Failed to install lavish-axi agent hooks", "SERVER_ERROR", errors);
  }

  return {
    hooks: { status: "installed", integrations: "Claude Code, Codex, OpenCode, GitHub Copilot CLI" },
    help: ["Restart your agent session to receive lavish-axi ambient context"],
  };
}

export function resolveHookHomeDir(env = process.env, fallback = os.homedir()) {
  return env.HOME || fallback;
}

export function resolveCopilotHookDir(env = process.env, homeDir = resolveHookHomeDir(env)) {
  return path.join(env.COPILOT_HOME || path.join(homeDir, ".copilot"), "hooks");
}

export function createCopilotCliAmbientContextScript(command = "lavish-axi") {
  return [
    'const { spawnSync } = require("node:child_process");',
    `const command = ${JSON.stringify(command)};`,
    'const result = spawnSync(command, [], { encoding: "utf8", shell: true });',
    'const detail = result.error ? result.error.message : (result.stderr || result.stdout || "exit " + (result.status ?? "unknown"));',
    "const text = String(result.status === 0 ? result.stdout : detail).trim();",
    'if (!text) { console.log("{}"); process.exit(0); }',
    'const prefix = result.status === 0 ? "## AXI ambient context: lavish-axi\\n" : "## AXI ambient context: lavish-axi\\nerror: lavish-axi ambient context failed: ";',
    "console.log(JSON.stringify({ additionalContext: prefix + text }));",
  ].join(" ");
}

export function createCopilotCliSessionStartHook(command = "lavish-axi", timeoutSec = 10) {
  const script = createCopilotCliAmbientContextScript(command);
  return {
    type: "command",
    bash: `node -e ${quoteForPosixShell(script)}`,
    powershell: `node -e ${quoteForPowerShell(script)}`,
    timeoutSec,
  };
}

export function computeCopilotCliHookUpdate(settings, hook = createCopilotCliSessionStartHook()) {
  const updated = structuredClone(settings && typeof settings === "object" ? settings : {});
  let changed = false;

  if (updated.version !== 1) {
    updated.version = 1;
    changed = true;
  }
  if (!updated.hooks || typeof updated.hooks !== "object" || Array.isArray(updated.hooks)) {
    updated.hooks = {};
    changed = true;
  }

  const current = Array.isArray(updated.hooks.sessionStart) ? updated.hooks.sessionStart : [];
  const unmanaged = current.filter((entry) => !isManagedCopilotCliHook(entry));
  const next = [...unmanaged, hook];

  if (!deepEqual(current, next)) {
    updated.hooks.sessionStart = next;
    changed = true;
  }

  return [changed ? updated : settings, changed];
}

export function installCopilotCliSessionStartHook({
  hookDir = resolveCopilotHookDir(),
  command = "lavish-axi",
  timeoutSec = 10,
  onError = undefined,
} = {}) {
  const target = path.join(hookDir, "lavish-axi.json");
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const current = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : {};
    const [updated, changed] = computeCopilotCliHookUpdate(
      current,
      createCopilotCliSessionStartHook(command, timeoutSec),
    );
    if (changed) {
      writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onError?.(`${target}: ${message}`);
  }
}

function isManagedCopilotCliHook(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    (typeof entry.bash === "string" || typeof entry.powershell === "string" || typeof entry.command === "string") &&
    [entry.bash, entry.powershell, entry.command].some(
      (value) => typeof value === "string" && value.includes("lavish-axi"),
    )
  );
}

function quoteForPosixShell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteForPowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function serverCommand(args) {
  const port = Number(flagValue(args, "--port") || defaultPort());
  const debug = args.includes("--verbose") || process.env.LAVISH_AXI_DEBUG === "1";
  const server = await serve({ port, stateFile: stateFile(), version: VERSION, debug });
  await server.done;
  return "";
}

async function listOpenSessions() {
  const store = new SessionStore(stateFile());
  return store.listSessions();
}

async function assertHtmlFile(file) {
  if (!isHtmlPath(file)) {
    throw new AxiError("Lavish Editor expects an HTML file", "VALIDATION_ERROR", ["Run `lavish-axi <html-file>`"]);
  }
  try {
    await access(file);
  } catch {
    throw new AxiError(`File not found: ${file}`, "NOT_FOUND", [
      "Create the HTML artifact first, then run `lavish-axi <html-file>`",
    ]);
  }
}

function isHtmlPath(file) {
  return file.toLowerCase().endsWith(".html") || file.toLowerCase().endsWith(".htm");
}

async function ensureServer({ forceRestart = false } = {}) {
  const port = defaultPort();
  const baseUrl = `http://${hostForUrl(clientHost())}:${port}`;
  const existing = await fetchHealth(baseUrl);
  if (existing && !shouldRestartServer(VERSION, existing, forceRestart)) {
    return baseUrl;
  }
  if (existing) {
    if (!(await canControlServerOnPort(port, existing, processOnPortMatchesLavish))) {
      throw new AxiError(`Port ${port} is occupied by a non-Lavish server`, "SERVER_ERROR", [
        `Stop the process using port ${port}, or set LAVISH_AXI_PORT to another port`,
      ]);
    }
    // Stale server from an older release is squatting on the port. Ask it to shut down
    // gracefully so the upgraded client doesn't keep handing users an old chrome.
    await requestShutdown(baseUrl);
    const freed = await waitForPortFree(baseUrl, 2000);
    if (!freed) {
      // Pre-handshake servers (any release older than this change) don't expose /shutdown
      // so the POST 404'd. Fall back to SIGTERM by PID so the very first upgrade still
      // works, then keep waiting.
      if (shouldKillProcessOnPort(VERSION, existing)) {
        killProcessOnPort(port);
        await waitForPortFree(baseUrl, 3000);
      }
    }
  }
  await startServer(port);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl);
    if (health && !shouldRestartServer(VERSION, health)) {
      return baseUrl;
    }
    await delay(100);
  }
  throw new AxiError("Lavish Editor server did not start", "SERVER_ERROR", [
    `Run \`lavish-axi server --port ${port}\` to inspect server startup`,
  ]);
}

// Pure helper so the upgrade-detection logic is unit-testable without spinning up HTTP.
// Returns true when the running server is a different (or pre-handshake) version than
// what this CLI was built with - i.e. the user just upgraded and the stale server needs
// to step aside.
export function shouldRestartServer(currentVersion, healthBody, forceRestart = false) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (forceRestart && healthBody.app === "lavish-axi") return true;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  return healthBody.version !== currentVersion;
}

export function shouldForceRestartForLocalBuild(executablePath, sourceServerExists = localSourceServerExists()) {
  const localBuildEntry = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
  return sourceServerExists && path.resolve(executablePath) === path.resolve(localBuildEntry);
}

function localSourceServerExists() {
  return existsSync(fileURLToPath(new URL("../src/server.js", import.meta.url)));
}

export function shouldKillProcessOnPort(currentVersion, healthBody) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (typeof healthBody.version !== "string" || healthBody.version === "") return true;
  if (healthBody.app !== "lavish-axi") return false;
  return healthBody.version !== currentVersion;
}

async function canControlServerOnPort(port, healthBody, processMatchesLavish) {
  if (!healthBody || typeof healthBody !== "object") return false;
  if (healthBody.app === "lavish-axi") return true;
  if (typeof healthBody.version === "string" && healthBody.version !== "") return false;
  return processMatchesLavish(port);
}

async function fetchHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function requestShutdown(baseUrl) {
  try {
    await fetch(`${baseUrl}/shutdown`, { method: "POST" });
  } catch {
    // Best effort. If the server died before answering, the port will free up on its own.
  }
}

async function waitForPortFree(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(baseUrl))) return true;
    await delay(100);
  }
  return false;
}

// Last-resort fallback for the bootstrap upgrade case: a pre-handshake server is squatting
// on the port and doesn't expose /shutdown, so we resolve its PID via lsof and SIGTERM it.
// macOS/Linux only - Windows users would need to kill manually, but lavish-axi isn't
// shipped for Windows today.
function killProcessOnPort(port) {
  try {
    const result = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (result.status !== 0) return;
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process already gone or permission denied - either way nothing we can do.
        }
      }
    }
  } catch {
    // lsof missing or unsupported platform - the outer caller will surface SERVER_ERROR.
  }
}

function processOnPortMatchesLavish(port) {
  try {
    const pids = spawnSync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (pids.status !== 0) return false;
    for (const line of pids.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (command.status === 0 && /lavish-axi/.test(command.stdout)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function startServer(port) {
  await ensureStateDir();
  const entry = resolveServerEntry();
  let logFd = null;
  try {
    logFd = openSync(serverLogFile(), "a");
  } catch {
    // If logging cannot be initialized, keep the server behavior unchanged.
  }
  try {
    const child = spawn(process.execPath, [entry, "server", "--port", String(port)], createServerSpawnOptions(logFd));
    child.unref();
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
}

// The detached server child must point at a node-executable entry that actually invokes
// run(). In source layout that's `../bin/lavish-axi.js` (which calls run on import). In the
// published bundle, only `dist/cli.mjs` ships and it self-invokes via the bundled bin
// wrapper. Pick whichever exists.
export function resolveServerEntry() {
  const binEntry = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
  if (existsSync(binEntry)) return binEntry;
  return fileURLToPath(import.meta.url);
}

/**
 * @param {number | null} logFd
 * @returns {import("node:child_process").SpawnOptions}
 */
export function createServerSpawnOptions(logFd = null) {
  const stdio = /** @type {import("node:child_process").StdioOptions} */ (
    logFd === null ? "ignore" : ["ignore", logFd, logFd]
  );
  return {
    detached: true,
    stdio,
    env: { ...process.env, LAVISH_AXI_NO_OPEN: "1" },
  };
}

export async function fetchJson(url, { retries = 0, retryDelayMs = 250 } = {}) {
  let response;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      response = await fetch(url);
      break;
    } catch (error) {
      if (error instanceof AxiError) throw error;
      if (attempt >= retries) throw serverConnectionError();
      await delay(retryDelayMs);
    }
  }

  if (!response) throw serverConnectionError();
  if (!response.ok) {
    throw new AxiError(`Lavish Editor request failed: ${response.status}`, "SERVER_ERROR");
  }
  try {
    return await response.json();
  } catch {
    throw pollResponseInterruptedError();
  }
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw serverConnectionError();
  }
  if (!response.ok) {
    throw new AxiError(`Lavish Editor request failed: ${response.status}`, "SERVER_ERROR");
  }
  return response.json();
}

function serverConnectionError() {
  return new AxiError("Lavish Editor server connection failed", "SERVER_ERROR", [
    "Run `lavish-axi server --verbose` or inspect `~/.lavish-axi/server.log` (`LAVISH_AXI_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `lavish-axi poll <html-file>` command after the server is healthy",
  ]);
}

function pollResponseInterruptedError() {
  return new AxiError("Lavish Editor poll response was interrupted", "SERVER_ERROR", [
    "Run `lavish-axi server --verbose` or inspect `~/.lavish-axi/server.log` (`LAVISH_AXI_STATE_DIR/server.log` when set) for server startup or crash diagnostics",
    "Re-run the last `lavish-axi poll <html-file>` command after the server is healthy",
  ]);
}

function firstPositionalArg(args, valueFlags = []) {
  const flags = new Set(valueFlags);
  let positionalMode = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!positionalMode && arg === "--") {
      positionalMode = true;
      continue;
    }
    if (!positionalMode && isValueFlagToken(arg, flags)) {
      if (!arg.includes("=")) i += 1;
      continue;
    }
    if (!positionalMode && arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return null;
}

function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") return null;
    if (arg === flag) return args[i + 1] || null;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1) || null;
  }
  return null;
}

function optionalFlagString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

function isValueFlagToken(arg, flags) {
  for (const flag of flags) {
    if (arg === flag || arg.startsWith(`${flag}=`)) return true;
  }
  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getCommandHelp(command) {
  return createCommandHelp()[command] || null;
}

function createTopLevelHelp() {
  return `lavish-axi - Lavish AXI\n\nUsage:\n  lavish-axi\n  lavish-axi <html-file> [--no-open] [--no-gate]\n  lavish-axi export <html-file> [--out <path>]\n  lavish-axi share <html-file> [--password <pw>] [--token <t>]\n  lavish-axi stop\n  lavish-axi playbook [playbook_id]\n  lavish-axi design\n  lavish-axi setup hooks\n\n${DESIGN_SYSTEM_HINT}\n\nNote: Lavish displays artifacts; it never collects feedback. \`lavish-axi <html-file>\` opens the page, waits briefly for the browser's layout audit, and returns - there is nothing to poll or keep alive. Repair every returned layout failure and re-run the command to re-check; cosmetic and uncertain observations are never returned.\n\n`;
}

function createCommandHelp() {
  return {
    open: `Usage: lavish-axi <html-file> [--no-open] [--no-gate]\n\nDisplay an HTML artifact in the user's browser and return. Use --no-open when you only need the server and session to exist without opening another browser window; the layout-audit wait is skipped too, since no page is loading. Use --no-gate to skip the open-time layout curtain for this browser open. Set LAVISH_AXI_LAYOUT_AUDIT_WAIT_MS to change how long the open waits for the browser's audit (0 or "off" returns immediately).\n`,
    export: `Usage: lavish-axi export <html-file> [--out <path>]\n\nWrite a portable copy of an artifact: one HTML file with its LOCAL assets inlined (relative-path stylesheets, scripts, images, and fonts become inline <style>/<script> blocks and data URIs). Remote CDN/font references (https URLs) are left as links for the browser to load, so the file needs network to render those. Lavish makes no outbound requests - it only reads local files, confined to the artifact's directory. Defaults to writing <name>.export.html next to the source; pass --out to choose a path. The injected Lavish SDK is never included in an export.\n`,
    share: `Usage: lavish-axi share <html-file> [--password <pw>] [--token <t>]\n\nPublish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Lavish, and print a visitable URL. Shares are PUBLIC by default: anyone with the link can open the page, and it may be indexed or scraped. Pass --password to publish a PRIVATE password-protected page; viewers must supply the password to view. Builds the same local-inlined HTML as 'export' (local assets inlined; remote CDN/font URLs left as links and are not blocked by CSP on ht-ml.app, but still load over the viewer's network), then POSTs it to ht-ml.app's /v1 API. Creating a site needs no account or API key. The response includes the url plus a secret update_key (shown once) for updating or deleting the page later. Set LAVISH_AXI_HTML_APP_TOKEN (or pass --token) to attach an optional bearer token; it is never required. The injected Lavish SDK is never included.\n`,
    stop: `Usage: lavish-axi stop [--port <port>]\n\nShut down the background Lavish server. The server also stops itself when no browser has been connected for a while (LAVISH_AXI_IDLE_TIMEOUT_MS, default 30m) and immediately when the last session is deleted with nothing connected.\n`,
    playbook: `Usage: lavish-axi playbook [playbook_id]\n\nList focused artifact guidance playbooks, or show one playbook by ID. Known IDs: diagram, table, comparison, plan, code, input, slides.\n\n${PLAYBOOK_ROUTER_HELP}\n\nExamples:\n  lavish-axi playbook\n  lavish-axi playbook diagram\n  lavish-axi playbook input\n`,
    design: `Usage: lavish-axi design\n\nShow a copy-pasteable CDN snippet for Tailwind CSS browser runtime v4 + DaisyUI v5 + themes, Mermaid diagram tooling, a content-to-playbook router, an optional layout safety CSS snippet, plus technical reference for DaisyUI components. ${PLAYBOOK_ROUTER_HELP} Lavish artifacts stay portable HTML. This CDN snippet is the design fallback, not the default: inspect the subject project before falling back, and paste the layout safety CSS only when useful for dense nested grid/flex layouts, badges, wide fonts, or local media. ${DESIGN_PRIORITY_RULE}\n`,
    setup: `Usage: lavish-axi setup hooks\n\nInstall or repair agent SessionStart hooks for lavish-axi ambient context in Claude Code, Codex, OpenCode, and GitHub Copilot CLI. Restart your agent session afterward to receive the context.\n`,
    server: `Usage: lavish-axi server [--port 4387] [--verbose]\n\nRun the local Lavish server. Pass --verbose (or set LAVISH_AXI_DEBUG=1) to log session and watcher events to stderr. Detached server output is appended to ~/.lavish-axi/server.log, or LAVISH_AXI_STATE_DIR/server.log when set, for startup and crash diagnostics.\n\nLAVISH_AXI_HOST sets the bind address (default 127.0.0.1; a wildcard 0.0.0.0 or :: binds every interface). Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. LAVISH_AXI_LINK_HOST sets the hostname written into generated session links (default: the bind address, or loopback when bound to a wildcard). See README's Allowed hosts section for Host allowlisting and LAVISH_AXI_ALLOWED_HOSTS. LAVISH_AXI_NO_OPEN=1 (or --no-open) suppresses the local browser launch.\n`,
  };
}

export { createDesignOutput };
