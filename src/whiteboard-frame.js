/* global document, window, location */

// Browser entry for the whiteboard frame. It runs in two placements, both
// sandboxed (`allow-scripts allow-popups`, no `allow-same-origin`): inline,
// where the artifact SDK embeds one frame in place of each rendered Mermaid
// diagram; and overlay, where the chrome hosts one frame full-viewport (reached
// from the inline frame's fullscreen action). The `mode` field of the init
// message selects the placement-specific UI; everything else is identical.
// Bundled by `scripts/build.js` (esbuild) together with Excalidraw, the Mermaid
// converter, its own exactly-pinned mermaid, and React into
// `dist/whiteboard/whiteboard.js`, so nothing here loads from the network.
//
// The frame is a viewer, not an editor: Excalidraw runs permanently in view
// mode, nothing is persisted, and the artifact's Mermaid source stays the only
// representation of the diagram. It holds no server access; the chrome does the
// same-origin fetches. Untrusted Mermaid text therefore renders only inside
// opaque origins, exactly like the artifact iframe.

import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import { convertToExcalidrawElements, Excalidraw, exportToCanvas, FONT_FAMILY } from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "@excalidraw/excalidraw/index.css";
import "./whiteboard-frame.css";

import {
  convertExcalidrawSkeletonsAfterFontsLoad,
  findDuplicateElementIds,
  formalizeSceneElements,
  sanitizeSceneLink,
  sceneIsImageFallback,
} from "./whiteboard-core.js";

const state = {
  mode: "overlay",
  diagramIndex: 0,
  diagramId: "",
  currentSource: "",
  currentSourceHash: "",
  imageFallback: false,
  channelId: "",
  theme: "light",
  root: null,
};

function post(message) {
  window.top.postMessage(
    {
      ...message,
      diagramIndex: state.diagramIndex,
      ...(state.channelId
        ? { channelId: state.channelId }
        : {
            channelToken: String(/** @type {any} */ (window).__lavishWhiteboardChannelToken || ""),
            diagramId: state.diagramId,
          }),
    },
    "*",
  );
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function setBanner(id, text) {
  const banner = document.getElementById(id);
  if (!banner) return;
  banner.textContent = text;
  banner.hidden = !text;
}

function buildShell(theme, mode) {
  document.body.dataset.lavishWhiteboardTheme = theme;
  document.body.dataset.lavishWhiteboardMode = mode;
  const shell = el("div", { id: "wbShell" });
  const header = el("header", { id: "wbHeader" });
  const title = el("div", { id: "wbTitle", textContent: "Diagram" });
  // In overlay mode the chrome renders the close control on top of this
  // header's right edge (it must work even when this frame fails to boot), so
  // the header reserves that space via CSS instead of adding its own close.
  // Inline frames offer a fullscreen action instead, which asks the chrome to
  // reopen this diagram in the overlay.
  header.append(title);
  if (mode === "inline") {
    const fullscreenButton = el("button", {
      id: "wbFullscreen",
      type: "button",
      textContent: "Fullscreen",
      title: "Open this diagram full screen",
    });
    fullscreenButton.onclick = () => post({ type: "lavish-whiteboard:maximize", diagramIndex: state.diagramIndex });
    header.append(fullscreenButton);
  }
  const fallbackBanner = el("div", { id: "wbFallbackBanner", className: "wb-banner", hidden: true });
  const status = el("div", { id: "wbStatus", className: "wb-status", hidden: true });
  const editor = el("div", { id: "wbEditor" });
  const linkConfirm = el("div", { id: "wbLinkConfirm", className: "wb-link-confirm", hidden: true });
  linkConfirm.setAttribute("role", "dialog");
  linkConfirm.setAttribute("aria-modal", "true");
  linkConfirm.setAttribute("aria-label", "Open external link");
  const linkConfirmCard = el("div", { className: "wb-link-confirm-card" });
  const linkConfirmTitle = el("div", { className: "wb-link-confirm-title", textContent: "Open external link?" });
  const linkConfirmCopy = el("p", {
    className: "wb-link-confirm-copy",
    textContent: "This link came from the diagram.",
  });
  const linkConfirmUrl = el("p", { id: "wbLinkConfirmUrl", className: "wb-link-confirm-url" });
  const linkConfirmActions = el("div", { className: "wb-link-confirm-actions" });
  const linkConfirmCancel = el("button", {
    id: "wbLinkConfirmCancel",
    type: "button",
    textContent: "Cancel",
  });
  const linkConfirmOpen = el("button", {
    id: "wbLinkConfirmOpen",
    type: "button",
    textContent: "Open link",
  });
  linkConfirmActions.append(linkConfirmCancel, linkConfirmOpen);
  linkConfirmCard.append(linkConfirmTitle, linkConfirmCopy, linkConfirmUrl, linkConfirmActions);
  linkConfirm.append(linkConfirmCard);
  shell.append(header, fallbackBanner, status, editor, linkConfirm);
  document.body.append(shell);

  linkConfirmCancel.onclick = dismissLinkConfirmation;
  linkConfirmOpen.onclick = () => {
    const safe = String(linkConfirm.dataset.url || "");
    if (safe) window.open(safe, "_blank", "noopener,noreferrer");
    dismissLinkConfirmation();
  };
  linkConfirm.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissLinkConfirmation();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = [linkConfirmCancel, linkConfirmOpen];
    const activeIndex = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    const nextIndex = event.shiftKey ? activeIndex - 1 : activeIndex + 1;
    if (nextIndex >= 0 && nextIndex < buttons.length) return;
    event.preventDefault();
    buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
  });
}

let statusTimer = 0;
function showStatus(text, { transient = true } = {}) {
  const status = document.getElementById("wbStatus");
  if (!status) return;
  status.textContent = text;
  status.hidden = !text;
  if (transient && text) {
    window.clearTimeout(statusTimer);
    statusTimer = window.setTimeout(() => {
      status.hidden = true;
    }, 4000);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @type {{ focus?: () => void } | null} */
let linkConfirmationReturnFocus = null;

function dismissLinkConfirmation() {
  const dialog = document.getElementById("wbLinkConfirm");
  if (dialog) dialog.hidden = true;
  const returnFocus = linkConfirmationReturnFocus;
  linkConfirmationReturnFocus = null;
  returnFocus?.focus?.();
}

function showLinkConfirmation(safe) {
  const dialog = document.getElementById("wbLinkConfirm");
  const url = document.getElementById("wbLinkConfirmUrl");
  const cancel = /** @type {HTMLButtonElement | null} */ (document.getElementById("wbLinkConfirmCancel"));
  if (!dialog || !url || !cancel) return;
  const activeElement = /** @type {{ focus?: () => void } | null} */ (document.activeElement);
  linkConfirmationReturnFocus = activeElement && typeof activeElement.focus === "function" ? activeElement : null;
  dialog.dataset.url = safe;
  url.textContent = safe;
  dialog.hidden = false;
  cancel.focus();
}

function onLinkOpen(element, event) {
  event.preventDefault();
  const safe = sanitizeSceneLink(element?.link);
  if (!safe) {
    showStatus("Blocked a link with an unsupported or unsafe scheme.");
    return;
  }
  showLinkConfirmation(safe);
}

// View-only canvas. `viewModeEnabled` is permanently on, so the diagram pans and
// zooms but nothing about it can be changed - there is nowhere for an edit to go.
function ViewerApp({ elements, files, theme }) {
  return React.createElement(Excalidraw, {
    initialData: { elements, appState: defaultAppState(), files: files || undefined, scrollToContent: true },
    theme,
    viewModeEnabled: true,
    onLinkOpen,
    excalidrawAPI: (api) => {
      // Fit the whole scene into the frame - inline frames are far smaller than
      // the scene's natural 100% size, and a zoomed-in corner of a diagram reads
      // as broken.
      window.setTimeout(() => {
        try {
          api.scrollToContent(api.getSceneElements(), { fitToContent: true });
        } catch {
          // scrollToContent is cosmetic; initialData already centered us.
        }
      }, 0);
    },
    UIOptions: {
      canvasActions: {
        loadScene: false,
        saveToActiveFile: false,
        toggleTheme: false,
      },
    },
  });
}

function mountViewer({ elements, files, theme }) {
  const editorHost = document.getElementById("wbEditor");
  if (!state.root) state.root = createRoot(editorHost);
  state.root.render(React.createElement(ViewerApp, { elements, files, theme }));
}

function fontFamilyName(fontFamily) {
  return Object.entries(FONT_FAMILY).find(([, value]) => value === fontFamily)?.[0] || "Segoe UI Emoji";
}

function fontString(element) {
  const family = fontFamilyName(element.fontFamily);
  const families = family === "Excalifont" ? [family, "Xiaolai", "Segoe UI Emoji"] : [family, "Segoe UI Emoji"];
  return `${Number(element.fontSize) || 20}px ${families.map((value) => JSON.stringify(value)).join(", ")}`;
}

async function loadSceneFonts(elements, files) {
  const textElements = elements.filter((element) => element.type === "text" && !element.isDeleted);
  if (textElements.length === 0) return;
  await exportToCanvas({
    elements,
    appState: { exportBackground: false },
    files: files || null,
    maxWidthOrHeight: 1,
  });
  await Promise.all(
    textElements.map((element) => document.fonts.load(fontString(element), String(element.text || ""))),
  );
  await document.fonts.ready;
}

async function convertSource(source) {
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(source, {
    themeVariables: { fontSize: "16px" },
  });
  const materialize = (input) => {
    // Preserve Mermaid node/edge identity where upstream allows it; regenerate
    // only when it emitted colliding ids (parallel edges), where uniqueness
    // matters more than identity.
    let elements = convertToExcalidrawElements(input, { regenerateIds: false });
    if (findDuplicateElementIds(elements).length > 0) {
      elements = convertToExcalidrawElements(input, { regenerateIds: true });
    }
    return elements;
  };
  const elements = formalizeSceneElements(
    await convertExcalidrawSkeletonsAfterFontsLoad(skeletons, {
      convert: materialize,
      loadFonts: async (fallbackElements) => {
        await loadSceneFonts(fallbackElements, files);
      },
    }),
  );
  return { elements, files: files || {}, imageFallback: sceneIsImageFallback(elements) };
}

// Theme is passed only through the <Excalidraw theme> prop - putting it in
// appState as well double-applies the dark-mode invert filter and washes the
// canvas out. The background stays a light paper color in both themes; dark
// mode derives its rendering from it via Excalidraw's own filter.
function defaultAppState() {
  return {
    viewBackgroundColor: "#ffffff",
  };
}

async function renderSource(source, theme) {
  const { elements, files, imageFallback } = await convertSource(source);
  state.imageFallback = imageFallback;
  setBanner(
    "wbFallbackBanner",
    imageFallback ? "This diagram type is not natively convertible, so it is shown as an image." : "",
  );
  mountViewer({ elements, files, theme });
}

async function handleInit(init) {
  state.mode = init.mode === "inline" ? "inline" : "overlay";
  state.diagramIndex = Number(init.diagramIndex) || 0;
  state.diagramId = String(init.diagramId || "");
  state.currentSource = String(init.source || "");
  state.currentSourceHash = String(init.sourceHash || "");
  state.theme = init.theme === "dark" ? "dark" : "light";
  document.getElementById("wbTitle").textContent = `Diagram ${state.diagramIndex + 1}`;

  try {
    await renderSource(state.currentSource, state.theme);
  } catch (error) {
    showStatus(`Could not render this diagram: ${describeError(error)}`, { transient: false });
  }
}

// The artifact changed on disk under an open fullscreen view. Nothing here is
// the user's, so re-convert straight away instead of offering a stale choice.
async function handleSourceChanged(message) {
  const nextHash = String(message.sourceHash || "");
  if (nextHash === state.currentSourceHash) return;
  state.currentSource = String(message.source || "");
  state.currentSourceHash = nextHash;
  try {
    await renderSource(state.currentSource, state.theme);
  } catch (error) {
    showStatus(`Could not render the updated diagram: ${describeError(error)}`, { transient: false });
  }
}

function main() {
  /** @type {any} */ (window).EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;
  const frameUrl = new URL(location.href);
  const diagramIndex = Number(frameUrl.searchParams.get("diagramIndex"));
  state.diagramIndex = Number.isInteger(diagramIndex) && diagramIndex >= 0 && diagramIndex <= 999 ? diagramIndex : 0;
  state.diagramId = String(frameUrl.searchParams.get("diagramId") || "");
  let initialized = false;
  window.addEventListener("message", (event) => {
    if (event.source !== window.top) return;
    const msg = event.data || {};
    if (msg.type === "lavish-whiteboard:init" && !initialized && typeof msg.channelId === "string" && msg.channelId) {
      initialized = true;
      state.channelId = msg.channelId;
      buildShell(msg.theme === "dark" ? "dark" : "light", msg.mode === "inline" ? "inline" : "overlay");
      handleInit(msg);
    }
    if (!initialized || msg.channelId !== state.channelId) return;
    if (msg.type === "lavish-whiteboard:sourceChanged") handleSourceChanged(msg);
  });
  post({ type: "lavish-whiteboard:ready" });
}

main();
