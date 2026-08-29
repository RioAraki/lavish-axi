---
name: lavish
description: Display a complex or visual agent response as a rich HTML page in the user's browser, using the lavish-axi CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
argument-hint: <what the artifact should show>
author: Kun Chen (kunchenguid)
metadata:
  hermes:
    tags: [html, artifacts, visualization]
    category: productivity
---

# Lavish

Lavish turns an agent's complex or visual response into a rich HTML page displayed in the user's browser. Whenever you are about to give the user a response that is easier to understand as a page than as prose, build the page and show it with Lavish. Generate an interactive HTML artifact, then run `npx -y lavish-axi <html-file>` to display it. That command returns immediately - Lavish is a display surface, not a feedback channel, so continue the conversation here once the page is open.

You do not need lavish-axi installed globally - invoke it with `npx -y lavish-axi <html-file>`.
If lavish-axi output shows a follow-up command starting with `lavish-axi`, run it as `npx -y lavish-axi ...` instead.
In restricted subprocess sandboxes, CI, or agent harnesses where `npx -y` exits opaquely (for example with status 216), use an already-installed copy directly: `node "$(npm root)/lavish-axi/dist/cli.mjs" <html-file>` for a local install, `node "$(npm root -g)/lavish-axi/dist/cli.mjs" <html-file>` for a global install, or the bare `lavish-axi <html-file>` bin after installing once.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/lavish` explicitly - build an HTML artifact for that request now, following the workflow below.
If it is empty, infer what to visualize from the conversation.

## When to use

Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, product or technical plan, comparison, report, diagram, or anything easier to grasp as a page than as prose

## Workflow

1. Create the HTML artifact (default location `.lavish/<name>.html` in the working directory).
2. Run `npx -y lavish-axi <html-file>` to display it in the browser. The command returns as soon as the page is open.
3. If it returns `layout_warnings`, repair the severe failure it reports and re-run the command to re-check before telling the user the page is ready.
4. Tell the user the page is open and summarize what it shows. Lavish collects nothing - the user replies to you in this conversation, not in the browser.
5. When they ask for changes, edit the artifact file. The open page live-reloads, so there is no command to re-run and nothing to poll, watch, or keep alive.

## Visual guidance

- Use visual hierarchy to make the most important decisions, risks, tradeoffs, and next actions obvious at a glance
- Use visual structure such as sections, cards, tables, diagrams, annotated snippets, and side-by-side comparisons instead of long prose
- Choose typography, spacing, color, and layout deliberately so the artifact has a clear point of view
- Prevent horizontal overflow at every nesting level: nested grid/flex children also need minmax(0, 1fr) tracks and min-width: 0, especially when badges, labels, or status text use wide pixel or monospace fonts; wrap, truncate, or contain long unbreakable text deliberately
- When the artifact would describe existing or current UI or state, show it instead: capture screenshots of the real pages (run the app read-only if needed) and embed them, rather than explaining the current look in prose; reserve prose for what cannot be shown such as rationale, trade-offs, and open questions

## Playbooks

Run `npx -y lavish-axi playbook <id>` for focused, detailed guidance on any of these.
One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
For flows, architecture, state, or sequence diagrams, do not hand-build boxes-and-arrows from div/flexbox; open the diagram playbook and use the theme-aware Mermaid snippet from `npx -y lavish-axi design` unless SVG is needed for richly annotated nodes.

- `diagram` - Map relationships, flows, state, and architecture
- `table` - Turn dense records into scan-friendly review surfaces
- `comparison` - Show options, tradeoffs, and current vs target behavior
- `plan` - Explain a product or technical plan before implementation
- `code` - Render source code, code files, patches, PR diffs, and before/after code inside Lavish artifacts
- `input` - Must be used when the agent needs to collect user input on decisions, choices, preferences, triage, scope, or other structured feedback from within the artifact
- `slides` - Create a deliberate presentation when slides are requested

## Commands & rules

- Run `npx -y lavish-axi <html-file>` to display an artifact in the user's browser. It opens (or refreshes) the page and returns right away - there is nothing to poll, subscribe to, or wait for. Tell the user the page is open and keep talking to them in this conversation; they will respond to you here, not in the browser
- Unless the user specifies another location, create HTML artifacts in the current working directory under `.lavish/`
- Lavish serves the html file through a local express.js server. If your html needs to reference other filesystem assets such as images, CSS, fonts, and local scripts, copy them into the same directory as the HTML file, then reference them with relative paths from that directory. Never prepend `/` to those asset paths - root paths won't work
- Before returning, `npx -y lavish-axi <html-file>` waits a few seconds for the real browser's render-time layout audit and includes any proven severe layout failures as `layout_warnings`. Repair every returned failure and re-run the command to re-check before telling the user the page is ready. Cosmetic, intentional, transient, tiny, and uncertain observations never appear; an absent audit reports no findings rather than a defect
- Editing the artifact file live-reloads the open page, so iterating on it needs no extra command - the browser updates itself and keeps its scroll position
- Rendered Mermaid diagrams in `.mermaid` containers are displayed as formally styled Excalidraw drawings in the browser (a Fullscreen action opens one over the whole viewport); flowchart, sequence, class, ER, and state diagrams convert to shapes, other types render as an image. They are view-only - the Mermaid source in the artifact stays the single representation of the diagram, and standalone or exported copies render plain Mermaid
- Run `npx -y lavish-axi export <html-file> [--out <path>]` to write a portable copy of the artifact - one HTML file with its LOCAL assets inlined - so it opens with no Lavish server and no sibling files. Remote CDN/font references are left as links, so it needs network to render those. Users can also export from the browser chrome's overflow menu
- Run `npx -y lavish-axi share <html-file> [--password <pw>] [--token <t>]` to publish the artifact on ht-ml.app (https://ht-ml.app), a third-party hosting service not part of Lavish, and get back a visitable URL. Shares are PUBLIC by default, so anyone with the link can open them. Pass --password to publish a PRIVATE password-protected page; viewers must supply the password to view. Local assets are inlined; remote refs load over the network. It returns the url plus a secret update_key for managing the page later. Use --token or LAVISH_AXI_HTML_APP_TOKEN only when you have an optional bearer token; it is never required. Users can also publish from the browser chrome's overflow menu
- Run `npx -y lavish-axi stop` to shut down the background server (it also self-stops when no browser has been connected for a while). Closing the browser tab is how a user is done with an artifact; there is no session to end
- Run `npx -y lavish-axi playbook <playbook_id>` for focused artifact guidance. One artifact often combines several playbooks (for example a plan that includes a comparison and a diagram), so MUST open each matching playbook before writing HTML.
- Lavish does not auto-inject any design system - artifacts stay portable so they render identically when opened directly without lavish-axi running. Before writing any HTML: Decide the design direction in this strict priority order, and only move to the next step when the current one truly yields nothing: (1) if the user asked for a specific look or named design system, use that; (2) otherwise you must first inspect the project the artifact is about - the subject or product whose content or UI it represents, which may differ from your current working directory - and match that project's design system: Tailwind or theme config, shared CSS variables or design tokens, component library, brand assets, or existing styled pages. If the artifact previews, proposes, or mocks a specific app's UI, render it in that app's own design system so it faithfully shows the product, even when you are running in a different repo; (3) only when both steps come up empty, use the Lavish-recommended Tailwind CSS browser runtime v4 + DaisyUI v5, available via CDN, and prefer that CDN snippet over hand-writing styles unless explicitly instructed otherwise by the user. Run `npx -y lavish-axi design` for a content-to-playbook router, a copy-pasteable CDN snippet, a Mermaid CDN snippet/init for diagrams, and the DaisyUI component reference. When you deliver the artifact, state which of the three design sources you used and why.
- Use lavish-axi when the user asks for a visual artifact, HTML explainer, interactive prototype, product or technical plan, comparison, report, diagram, or anything easier to grasp as a page than as prose
