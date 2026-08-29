import assert from "node:assert/strict";
import test from "node:test";

import {
  findDuplicateElementIds,
  formalizeSceneElements,
  FORMAL_FONT_FAMILY,
  sanitizeSceneLink,
  sceneIsImageFallback,
} from "../src/whiteboard-core.js";

function rect(id, opts = {}) {
  return { id, type: "rectangle", x: 0, y: 0, width: 100, height: 40, ...opts };
}

// ---------------------------------------------------------------------------
// sanitizeSceneLink
// ---------------------------------------------------------------------------

test("sanitizeSceneLink allows http(s) and mailto only", () => {
  assert.equal(sanitizeSceneLink("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(sanitizeSceneLink("http://localhost:3000"), "http://localhost:3000");
  assert.equal(sanitizeSceneLink("mailto:kun@example.com"), "mailto:kun@example.com");
});

test("sanitizeSceneLink rejects dangerous or unknown schemes", () => {
  assert.equal(sanitizeSceneLink("javascript:alert(1)"), "");
  assert.equal(sanitizeSceneLink("JAVASCRIPT:alert(1)"), "");
  assert.equal(sanitizeSceneLink("data:text/html,<script>1</script>"), "");
  assert.equal(sanitizeSceneLink("file:///etc/passwd"), "");
  assert.equal(sanitizeSceneLink("vbscript:x"), "");
  assert.equal(sanitizeSceneLink("relative/path"), "");
  assert.equal(sanitizeSceneLink(""), "");
  assert.equal(sanitizeSceneLink(null), "");
});

// ---------------------------------------------------------------------------
// sceneIsImageFallback
// ---------------------------------------------------------------------------

test("sceneIsImageFallback is true only for a non-empty all-image scene", () => {
  assert.equal(sceneIsImageFallback([{ id: "i1", type: "image" }]), true);
  assert.equal(sceneIsImageFallback([{ id: "i1", type: "image" }, rect("r1")]), false);
  assert.equal(sceneIsImageFallback([]), false);
  assert.equal(sceneIsImageFallback(null), false);
});

test("sceneIsImageFallback ignores deleted elements", () => {
  assert.equal(
    sceneIsImageFallback([
      { id: "i1", type: "image" },
      { ...rect("r1"), isDeleted: true },
    ]),
    true,
  );
});

// ---------------------------------------------------------------------------
// findDuplicateElementIds
// ---------------------------------------------------------------------------

test("findDuplicateElementIds finds repeated ids (parallel-edge upstream bug)", () => {
  assert.deepEqual(findDuplicateElementIds([rect("A"), rect("B"), rect("A")]), ["A"]);
  assert.deepEqual(findDuplicateElementIds([rect("A"), rect("B")]), []);
  assert.deepEqual(findDuplicateElementIds([]), []);
});

// ---------------------------------------------------------------------------
// repairSavedSceneTextMetrics
// ---------------------------------------------------------------------------

test("formalizeSceneElements flattens hand-drawn style without touching geometry or colors", () => {
  const elements = [
    {
      ...rect("a", { roughness: 1, fillStyle: "hachure" }),
      strokeColor: "#1971c2",
      backgroundColor: "#a5d8ff",
      strokeWidth: 2,
    },
    { id: "b", type: "text", text: "Hello", x: 5, y: 6, width: 40, height: 20, fontFamily: 5, fontSize: 16 },
  ];
  const snapshot = JSON.parse(JSON.stringify(elements));

  const formal = formalizeSceneElements(elements);

  assert.equal(formal[0].roughness, 0);
  assert.equal(formal[0].fillStyle, "solid");
  assert.equal(formal[0].strokeColor, "#1971c2");
  assert.equal(formal[0].backgroundColor, "#a5d8ff");
  assert.equal(formal[0].strokeWidth, 2);
  assert.deepEqual(
    { x: formal[0].x, y: formal[0].y, width: formal[0].width, height: formal[0].height },
    { x: 0, y: 0, width: 100, height: 40 },
  );
  assert.equal(formal[1].fontFamily, FORMAL_FONT_FAMILY);
  assert.equal(formal[1].fontSize, 16);
  // Input is never mutated, and the copies are fresh objects.
  assert.deepEqual(elements, snapshot);
  assert.notEqual(formal[0], elements[0]);
});

test("formalizeSceneElements only overrides props the element already carries", () => {
  const [formal] = formalizeSceneElements([{ id: "a", type: "image", x: 0, y: 0 }]);

  assert.deepEqual(formal, { id: "a", type: "image", x: 0, y: 0 });
  assert.equal(Object.hasOwn(formal, "roughness"), false);
  assert.equal(Object.hasOwn(formal, "fillStyle"), false);
  assert.equal(Object.hasOwn(formal, "fontFamily"), false);
});

test("formalizeSceneElements leaves non-object entries and non-array input alone", () => {
  assert.deepEqual(formalizeSceneElements([null, "nope", 7]), [null, "nope", 7]);
  assert.deepEqual(formalizeSceneElements(null), []);
  assert.deepEqual(formalizeSceneElements(undefined), []);
});
