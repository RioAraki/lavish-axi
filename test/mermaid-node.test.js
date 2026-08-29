import assert from "node:assert/strict";
import test from "node:test";

import { isMermaidSvg } from "../src/mermaid-node.js";

// ---------------------------------------------------------------------------
// Minimal fake-DOM helpers. The repo tests browser-side code with hand-built
// element stubs rather than a DOM library (see chrome-client-queue.test.js); we
// follow that convention and build only the surface these functions touch:
// tagName, id, textContent, getAttribute, closest, querySelector(All),
// cloneNode, and (for <br>) replaceWith.
// ---------------------------------------------------------------------------

function el(tag, opts = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    id: opts.id || "",
    className: opts.className || "",
    parentElement: null,
    children: [],
    attrs: { ...(opts.attrs || {}) },
    _text: opts.text || "",

    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
    },
    get textContent() {
      if (this.children.length === 0) return this._text;
      // <br> contributes nothing to textContent (matches real DOM).
      return this.children.map((c) => (c.tagName === "BR" ? "" : c.textContent)).join("");
    },
    closest(selectorList) {
      let current = this;
      while (current) {
        if (matchesSelectorList(current, selectorList)) return current;
        current = current.parentElement;
      }
      return null;
    },
    matches(selectorList) {
      return matchesSelectorList(this, selectorList);
    },
    querySelector(selectorList) {
      return descendants(this).find((d) => matchesSelectorList(d, selectorList)) || null;
    },
    querySelectorAll(selectorList) {
      return descendants(this).filter((d) => matchesSelectorList(d, selectorList));
    },
    cloneNode() {
      const clone = el(tag, {
        id: this.id,
        className: this.className,
        attrs: this.attrs,
        text: this._text,
      });
      for (const child of this.children) append(clone, child.cloneNode(true));
      return clone;
    },
    replaceWith(replacement) {
      const parent = this.parentElement;
      if (!parent) return;
      const idx = parent.children.indexOf(this);
      if (idx >= 0) parent.children.splice(idx, 1, replacement);
      replacement.parentElement = parent;
    },
  };
  for (const child of opts.children || []) append(node, child);
  return node;
}

function append(parent, child) {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function descendants(node) {
  const out = [];
  for (const child of node.children) {
    out.push(child);
    out.push(...descendants(child));
  }
  return out;
}

function matchesSelectorList(node, selectorList) {
  return selectorList.split(",").some((sel) => matchesSelector(node, sel.trim()));
}

function matchesSelector(node, selector) {
  // tag
  if (/^[a-z]+$/i.test(selector)) return node.tagName.toLowerCase() === selector.toLowerCase();
  // .class
  if (selector.startsWith(".")) return classList(node).includes(selector.slice(1));
  // [attr] or [attr='v']
  const attrMatch = selector.match(/^\[([a-z-]+)(?:='([^']*)')?\]$/i);
  if (attrMatch) {
    const value = node.getAttribute(attrMatch[1]);
    if (attrMatch[2] === undefined) return value !== null;
    return value === attrMatch[2];
  }
  // "g.node" style tag.class
  const tagClass = selector.match(/^([a-z]+)\.([a-z0-9_-]+)$/i);
  if (tagClass)
    return node.tagName.toLowerCase() === tagClass[1].toLowerCase() && classList(node).includes(tagClass[2]);
  // "g.nodes > g" — treat as: a <g> whose parent has class "nodes"
  if (selector === "g.nodes > g") {
    return node.tagName.toLowerCase() === "g" && node.parentElement && classList(node.parentElement).includes("nodes");
  }
  return false;
}

function classList(node) {
  return (node.className || "").split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// isMermaidSvg
// ---------------------------------------------------------------------------

test("isMermaidSvg matches the mermaid id prefix", () => {
  assert.equal(isMermaidSvg(el("svg", { id: "mermaid-1782877720504" })), true);
  assert.equal(isMermaidSvg(el("svg", { id: "mermaid_underscore" })), true);
});

test("isMermaidSvg matches aria-roledescription and .mermaid ancestor", () => {
  assert.equal(isMermaidSvg(el("svg", { attrs: { "aria-roledescription": "flowchart-v2" } })), true);
  const svg = el("svg");
  el("div", { className: "mermaid", children: [svg] });
  assert.equal(isMermaidSvg(svg), true);
});

test("isMermaidSvg matches the data-lavish-mermaid opt-in wrapper", () => {
  const svg = el("svg");
  el("figure", { attrs: { "data-lavish-mermaid": "" }, children: [svg] });
  assert.equal(isMermaidSvg(svg), true);
});

test("isMermaidSvg rejects a plain unrelated svg and null", () => {
  assert.equal(isMermaidSvg(el("svg", { id: "logo" })), false);
  assert.equal(isMermaidSvg(null), false);
});
