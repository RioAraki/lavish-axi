// Pure Mermaid detection helpers shared by the injected artifact SDK. The SDK ships
// them to the browser by serializing each one with `.toString()` (see `createSdkJs`),
// which drops the surrounding module scope — so a helper may reference only its own
// arguments, browser globals, or its sibling exports from this module. `createSdkJs`
// re-declares every export here as a same-scope `const` before invoking the SDK, so
// cross-helper calls resolve in the browser exactly as they do here; never close over
// anything else. Keeping the logic here — instead of inside the `createArtifactSdk`
// closure — lets us unit test it directly.

// True when an <svg> was produced by Mermaid. We key on Mermaid's own output
// markers (id prefix, aria-roledescription, or a `.mermaid` / opt-in ancestor)
// rather than on how the diagram got onto the page, so author-pasted CDN
// diagrams, other Mermaid versions, and opt-in wrappers all match identically.
export function isMermaidSvg(svg) {
  if (!svg) return false;
  const id = svg.id || "";
  if (id.startsWith("mermaid-") || id.startsWith("mermaid_")) return true;
  if (svg.getAttribute?.("aria-roledescription")) return true;
  return !!(svg.closest && svg.closest(".mermaid, [data-lavish-mermaid]"));
}
