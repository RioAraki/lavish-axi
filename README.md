<h1 align="center">lavish-axi</h1>
<p align="center">
  <a href="https://github.com/kunchenguid/lavish-axi/actions/workflows/ci.yml"
    ><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/lavish-axi/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/lavish-axi/actions/workflows/release-please.yml"
    ><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/lavish-axi/release-please.yml?style=flat-square&label=release"
  /></a>
  <a href="https://www.npmjs.com/package/lavish-axi"
    ><img alt="npm" src="https://img.shields.io/npm/v/lavish-axi?style=flat-square"
  /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img alt="Discord" src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">For when a rich answer is not rich enough.</h3>

<p align="center">
  <img alt="Lavish demo" src="lavish-editor-marketing/renders/lavish-editor-marketing.gif" width="960" />
</p>

HTML is the new markdown. Lavish is how your agent shows it to you.

Agents are good at producing rich HTML artifacts, but their answers still arrive as a wall of prose in a terminal.
That loses the thing HTML is best at: layout, hierarchy, and diagrams you can take in at a glance.

Lavish displays agent-generated HTML files in a local browser. Run it and the page is open - there is no session to babysit, nothing to poll, and no second channel to answer in. You keep talking to the agent where you already are.

- **Local-first** - Display local HTML artifacts with a local CLI and no cloud dependency; hosted sharing through third-party ht-ml.app is explicit and opt-in.
- **Fire and forget** - `lavish-axi <file>` opens the page and returns. Editing the file live-reloads the open page, so the agent iterates without another command.
- **Battery included** - Lavish teaches your agent good visualization for common use cases such as product or technical plans, design explorations and more out of the box.

Lavish is an [AXI](https://axi.md), which means -

- It's just a CLI any capable agent can run without setup.
- It's optimized for agent ergonomics. TOON output and contextual disclosure make it highly token efficient.
- The skill and hooks below only handle discovery; agents learn to use the AXI by using it.

## Quick Start

Install the Lavish skill in the [Agent Skills](https://agentskills.io) format with [`npx skills`](https://github.com/vercel-labs/skills):

```sh
npx skills add kunchenguid/lavish-axi --skill lavish
```

That is the entire setup - no npm install needed.
The skill teaches your agent to run Lavish through `npx -y lavish-axi`, so the CLI comes along on demand.
In restricted subprocess sandboxes, CI, or agent harnesses where `npx -y` exits opaquely, the skill also documents direct installed-copy fallbacks through the local or global npm install path.
Its frontmatter also includes Hermes Agent metadata, so Hermes-compatible harnesses can categorize and surface it as a first-class productivity skill.
This installs the public `lavish` skill.
The repository also contains an internal `lavish-design` brand skill for maintainers; default `npx skills add ... --list` and skills.sh discovery hide it unless `INSTALL_INTERNAL_SKILLS=1` is set.

Then, in agents that expose skills as slash commands (Claude Code, for example), invoke it directly:

```
/lavish let's discuss our plan here
```

Or just ask for anything that is easier to grasp visually - a plan, comparison, diagram, table, code view, or report - and the agent loads the skill on its own when it recognizes the task.

By default the skill lands in the current project's skills directory (`.claude/skills/`, for example); add `-g` to install it for all projects (`~/.claude/skills/`).

## Other Ways to Use Lavish

The skill is the recommended path, but it is not the only one.

### Zero setup

Lavish is an AXI, so any capable agent can run the CLI directly with nothing installed at all.
Just tell your agent:

```
Use `npx -y lavish-axi` to write a product or technical plan for what we discussed.
```

### Session hook

Want Lavish's ambient context - including your live open sessions - fed into every agent session instead of loading on demand?
Install the CLI globally and opt into the hook:

```sh
npm install -g lavish-axi
lavish-axi setup hooks
```

This installs a `SessionStart` hook for **Claude Code**, **Codex**, **OpenCode**, and **GitHub Copilot CLI** that surfaces open sessions, visualization playbooks, and usage guidance at the start of each session.
Unlike the skill, the hook also shows your live open sessions, so a fresh agent session can resume an in-flight review.
**Restart your agent session after running this** so the new hook takes effect.

### From source

```sh
git clone https://github.com/kunchenguid/lavish-axi.git
cd lavish-axi
pnpm install --frozen-lockfile
pnpm run build
pnpm link
```

## How It Works

```
┌───────────────┐
│ Agent writes  │
│ artifact.html │
└───────┬───────┘
        ▼
┌────────────────────────┐
│ lavish-axi <file_path> │
│ opens local browser UI │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ Browser renders it and │
│ audits its own layout  │
└───────┬────────────────┘
        ▼
┌────────────────────────┐
│ Command returns with   │
│ any severe failures.   │
│ Conversation continues │
│ in the agent, not here │
└────────────────────────┘
```

- **File-path identity** - Sessions are keyed by the canonical HTML file path, so agents do not need opaque IDs.
- **Portable artifacts** - The artifact runs in an iframe while Lavish injects a small SDK for diagram rendering, scroll restoration, and render-time layout checks.
  Lavish does not inject any design system, so the saved HTML file renders identically whether you open it through `lavish-axi` or directly in a browser.
  Run `lavish-axi design` for the single source of agent-facing design guidance and optional CDN or Mermaid snippets.
- **Open-time layout gate** - The browser chrome masks an artifact only while the real in-iframe audit checks for a stable, proven severe layout failure.
  A severe failure keeps the curtain up until a clean reload, while cosmetic, intentional, transient, tiny, and uncertain observations stay silent.
  The user can click **Show anyway**, and a bounded safety timeout fails open without an issue banner when no severe failure has been proven.
- **Layout failures** - After fonts and finite animations settle, the injected SDK confirms severe failures from direct rendered evidence such as materially escaped meaningful content or required controls, clipped text fragments, viewport reachability, or near-total semantic occlusion.
  Explicit ellipsis and line clamp, standard visually hidden accessibility text, intentional scrollers or masks, parent overhang, generic element scroll geometry, decorative overlap, and uncertain motion do not produce findings by themselves.
  `lavish-axi <html-file>` waits for that verdict before returning and includes proven failures in `layout_warnings` with `selector`, `kind`, `axis`, `overflowPx`, `viewportWidth`, and `severity`.
  The wait is bounded (`LAVISH_AXI_LAYOUT_AUDIT_WAIT_MS`, default 12 seconds; `0` or `off` returns immediately) and `--no-open` skips it, since no page is loading. A missing verdict reports no findings rather than a defect.
  Every returned failure should be fixed, then re-checked by re-running `lavish-axi <html-file>`, before telling the human the page is ready.
- **Local assets** - Copy local images, CSS, fonts, and scripts next to the HTML artifact and reference them with relative paths from that directory; root-prefixed paths such as `/assets/logo.png` will not resolve through Lavish's artifact route.
- **Export and sharing** - `lavish-axi export` writes `<name>.export.html` by inlining local assets only, stripping the injected Lavish SDK, and leaving remote CDN/font references as links that still need network access.
  `lavish-axi share` publishes the same local-inlined HTML to [ht-ml.app](https://ht-ml.app), a third-party hosting service not part of Lavish.
  Publishing sends the artifact to ht-ml.app's servers, public by default, or private and password-protected with `--password`; the response includes a secret `update_key` shown once for later management.
  Bundling never fetches remote URLs, Lavish itself does not set a CSP, local reads stay confined and size-capped, and absolute `file://` paths outside safe inlined asset references are redacted before output.
  Per-asset and per-bundle inline caps default to 10 MB and 25 MB, overridable with `LAVISH_AXI_EXPORT_MAX_ASSET_BYTES` and `LAVISH_AXI_EXPORT_MAX_BUNDLE_BYTES`.
  Unresolved local assets or export notices such as author-set CSP meta tags and redacted file URLs are surfaced in command or browser output.
  Use `--token` or `LAVISH_AXI_HTML_APP_TOKEN` for an optional bearer token; set `LAVISH_AXI_HTML_APP_API_URL` only when overriding the ht-ml.app API base.
- **Live reload** - Lavish watches the HTML artifact file by default and preserves the artifact iframe scroll position across reloads. To also reload on sibling asset changes, add `data-lavish-live-reload-root` to the root element or `<meta name="lavish-live-reload" content="root">`.
- **Browser chrome** - The chrome is a thin top bar over a full-width artifact iframe: a wordmark and one overflow menu (copy path, reload artifact, export standalone HTML, publish link).
  There is no annotation mode, conversation panel, composer, or session-end control - Lavish collects nothing from the browser, so feedback happens in the agent conversation instead.
  Escape closes the publish dialog, the fullscreen diagram, or the open menu.
- **Mermaid diagrams** - In the Lavish browser, every rendered Mermaid diagram in a `.mermaid` container is displayed as a formally styled Excalidraw drawing - flat strokes, solid fills, and a diagram typeface instead of Excalidraw's hand-drawn defaults.
  Use a diagram's Fullscreen action to view it over the whole viewport; the canvas pans and zooms but is view-only, and nothing is persisted.
  A live reload re-converts an open diagram from the artifact's current Mermaid source, which stays the single representation of the diagram.
  Flowchart, sequence, class, ER, and state diagrams convert to shapes; other diagram types render as an image.
  Lavish changes only the browser view, so saved, standalone, and exported artifacts still render plain Mermaid.
- **Server cleanup** - Closing the browser tab is how you are done with an artifact; there is no session to end.
  The detached server stops after the last session is deleted from the index when nothing is connected, or after `LAVISH_AXI_IDLE_TIMEOUT_MS` (default 30 minutes) with no browser connected.
  Set `LAVISH_AXI_IDLE_TIMEOUT_MS=0` or `off` to disable idle self-shutdown.
- **Local-first state** - Session state stays under `~/.lavish-axi/` by default, or `LAVISH_AXI_STATE_DIR` when set.
- **Server port** - Set `LAVISH_AXI_PORT` to choose the server port; it defaults to `4387`.
- **Network binding** - The server binds to loopback (`127.0.0.1`) by default. Set `LAVISH_AXI_HOST` to bind elsewhere; a wildcard (`0.0.0.0` or `::`) binds every interface. Binding beyond loopback exposes an unauthenticated server that can read and serve arbitrary local files to anything that can reach it, so only do so on a trusted network. Set `LAVISH_AXI_LINK_HOST` to control the hostname written into generated session links (defaults to the bind address, or loopback when bound to a wildcard).
- **Allowed hosts** - To defend against DNS rebinding, the server rejects (`403`) any request whose `Host` header is missing or not one it answers to: the loopback names (`127.0.0.1`, `::1`, `localhost`) plus the configured bind and link host. If you reach the server under another name - a wildcard bind accessed by LAN IP, a reverse-proxy hostname, or an extra interface - list those names in `LAVISH_AXI_ALLOWED_HOSTS` (whitespace-separated) to allow them. Behind a reverse proxy, the forwarded `X-Forwarded-Host` is validated against the same list, so add your public hostname there and have the proxy send it. Set `LAVISH_AXI_ALLOWED_HOSTS` to `*` to disable the check entirely (only when the server sits behind your own authentication or proxy).
- **Browser opening** - Set `LAVISH_AXI_NO_OPEN=1`, equivalent to `--no-open`, to create or resume a session without launching a browser window. This also skips the layout-audit wait, since no page is loading.
- **Session index** - `http://127.0.0.1:4387/session` lists every artifact opened on this machine, by folder or by recency, so a closed tab is never a lost page. Deleting a card removes the session _and_ its artifact HTML file from disk.

## CLI Reference

| Command                         | Description                                                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lavish-axi`                    | Show current sessions and usage guidance.                                                                                                                                                                                                                                 |
| `lavish-axi update`             | Check for or apply the latest npm release through the AXI SDK self-updater.                                                                                                                                                                                               |
| `lavish-axi <html-file>`        | Display an artifact in the browser, with the open-time layout gate enabled by default. Waits briefly for the browser's layout audit, returns any proven severe failures as `layout_warnings`, and exits - there is nothing to poll or keep alive.                         |
| `lavish-axi export <html-file>` | Write a portable copy of the artifact: one HTML file with its local assets inlined, so it opens with no server and no sibling files. Remote CDN/font references are left as links.                                                                                        |
| `lavish-axi share <html-file>`  | Publish the artifact (local assets inlined) to [ht-ml.app](https://ht-ml.app), a third-party host not part of Lavish, and print a visitable URL plus a secret update key; shares are public by default, and `--password` makes viewers enter the password before viewing. |
| `lavish-axi stop`               | Shut down the background server.                                                                                                                                                                                                                                          |
| `lavish-axi playbook [id]`      | List focused artifact guidance or show one playbook; agents must open each matching playbook before writing HTML.                                                                                                                                                         |
| `lavish-axi design`             | Show agent-facing design guidance, including optional CDN and Mermaid snippets.                                                                                                                                                                                           |
| `lavish-axi setup hooks`        | Install or repair optional SessionStart hooks for Claude Code, Codex, OpenCode, and GitHub Copilot CLI; restart the agent session afterward.                                                                                                                              |
| `lavish-axi server`             | Run the local Lavish server.                                                                                                                                                                                                                                              |

Known playbook IDs: `diagram`, `table`, `comparison`, `plan`, `code`, `input`, `slides`.
One artifact often combines several playbooks, such as a plan that includes a comparison and a diagram, so agents must match against each `use_when` trigger and open every matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, open the diagram playbook for the recommended tooling and SVG guidance.

### Flags

| Command                  | Flag              | Description                                                                                                                                                                                                                         |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lavish-axi <html-file>` | `--no-open`       | Ensure the server/session exists without opening another browser window.                                                                                                                                                            |
| `lavish-axi <html-file>` | `--no-gate`       | Skip the open-time layout curtain for this browser open.                                                                                                                                                                            |
| `lavish-axi update`      | `--check`         | Report current vs latest npm version without installing an update.                                                                                                                                                                  |
| `lavish-axi export`      | `--out <path>`    | Write the export to a specific path instead of `<name>.export.html` next to the source.                                                                                                                                             |
| `lavish-axi share`       | `--password <pw>` | Make the third-party ht-ml.app page private; viewers must supply the password.                                                                                                                                                      |
| `lavish-axi share`       | `--token <t>`     | Attach an optional bearer token (`LAVISH_AXI_HTML_APP_TOKEN`); never required to publish.                                                                                                                                           |
| `lavish-axi stop`        | `--port <port>`   | Shut down a server running on a non-default port.                                                                                                                                                                                   |
| `lavish-axi server`      | `--verbose`       | Log session and watcher events to stderr; can also be enabled with `LAVISH_AXI_DEBUG=1`. Detached server output is appended to `~/.lavish-axi/server.log` (or `LAVISH_AXI_STATE_DIR/server.log`) for startup and crash diagnostics. |

## Development

```sh
pnpm run check          # Run all verification commands
pnpm run build          # Bundle the publishable CLI, chrome, and design assets
pnpm run build:skill    # Regenerate the installable lavish skill
pnpm test               # Run node:test tests
pnpm run lint           # Run ESLint
pnpm run format:check   # Check Prettier formatting
pnpm run typecheck      # Run TypeScript checkJs validation
```
