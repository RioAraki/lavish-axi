// Pure whiteboard helpers shared by the whiteboard frame bundle (esbuild) and the
// server. Everything here is plain data-in/data-out so it unit tests under
// node:test without a DOM and ships to the browser through normal module imports
// in the bundled whiteboard frame (unlike mermaid-node.js helpers, these are never
// serialized with `.toString()`).

// Excalidraw's FONT_FAMILY.Normal (Helvetica). The converter's hand-drawn default is
// Excalifont, which reads as a sketch rather than a diagram.
export const FORMAL_FONT_FAMILY = 2;

// Mermaid conversions inherit Excalidraw's hand-drawn defaults - rough strokes, hachure
// fills, handwriting font - which look drafty and hurt legibility for diagrams meant to be
// read. Flatten those three style props while preserving geometry and whatever colors the
// converter (or the diagram's own theme) chose. Props the element does not already carry are
// never introduced, so non-shape elements stay untouched.
export function formalizeSceneElements(elements) {
  return (Array.isArray(elements) ? elements : []).map((element) => {
    if (!element || typeof element !== "object" || Array.isArray(element)) return element;
    const formal = { ...element };
    if (Object.hasOwn(formal, "roughness")) formal.roughness = 0;
    if (Object.hasOwn(formal, "fillStyle")) formal.fillStyle = "solid";
    if (Object.hasOwn(formal, "fontFamily")) formal.fontFamily = FORMAL_FONT_FAMILY;
    return formal;
  });
}

// Only plain web/mail links may leave the whiteboard. Everything else -
// javascript:, data:, file:, vbscript:, chrome:, about:, or relative noise
// coming from untrusted Mermaid `click` directives - is dropped.
export function sanitizeSceneLink(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^mailto:[^\s]+$/i.test(value)) return value;
  return "";
}

// True when a conversion produced the converter's image fallback (an
// unsupported diagram type, or a parser error caught in-library): the scene is
// one or more image elements and nothing else. The diagram still displays -
// just as a flat image rather than as shapes.
export function sceneIsImageFallback(elements) {
  const list = Array.isArray(elements) ? elements.filter((el) => el && !el.isDeleted) : [];
  if (list.length === 0) return false;
  return list.every((el) => el.type === "image");
}

// `convertToExcalidrawElements(..., { regenerateIds: false })` preserves the
// Mermaid node/edge ids, but upstream can emit the same id twice for parallel
// edges (mermaid-to-excalidraw#110). Excalidraw requires unique ids, so callers
// regenerate ids for the whole scene when this returns a non-empty list.
export function findDuplicateElementIds(elements) {
  const seen = new Set();
  const duplicates = new Set();
  for (const el of Array.isArray(elements) ? elements : []) {
    const id = String(el?.id || "");
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

// Excalidraw measures text synchronously while materializing skeletons. Its
// bundled fonts load asynchronously, so the first pass also gives the caller
// the concrete text elements needed to request exactly those fonts. Always
// materialize again after that request so the second pass records the real
// glyph metrics before anything reaches the visible canvas.
/**
 * @template T
 * @template E
 * @param {T[]} skeletons
 * @param {{ convert: (skeletons: T[]) => E[], loadFonts: (elements: E[]) => Promise<unknown> }} adapters
 * @returns {Promise<E[]>}
 */
export async function convertExcalidrawSkeletonsAfterFontsLoad(skeletons, { convert, loadFonts }) {
  const fallbackElements = convert(skeletons);
  await loadFonts(fallbackElements);
  return convert(skeletons);
}
