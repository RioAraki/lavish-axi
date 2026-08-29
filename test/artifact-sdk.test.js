import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMaterialRectEscape,
  classifySevereTextOverflow,
  findStableLayoutFindings,
  isMaterialPageOverflow,
  isNearTotalOcclusion,
} from "../src/artifact-sdk.js";

test("classifySevereTextOverflow ignores font ink that stays within the rendered line box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 400, top: 0, bottom: 68, width: 400, height: 68 }],
    box: { left: 0, right: 400, top: 0, bottom: 68 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores tiny text-box excursions", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 300, top: 0, bottom: 70, width: 300, height: 70 }],
    box: { left: 0, right: 300, top: 0, bottom: 68 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores centered display glyph ink outside a visible line box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 600, top: -37, bottom: 203, width: 600, height: 240 }],
    box: { left: 0, right: 600, top: 0, bottom: 166 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow ignores a partial vertical line excursion whose center remains visible", () => {
  const finding = classifySevereTextOverflow({
    fragments: [{ left: 0, right: 280, top: 0, bottom: 20, width: 280, height: 20 }],
    box: { left: 0, right: 300, top: 0, bottom: 14 },
    overflowX: "hidden",
    overflowY: "hidden",
  });

  assert.equal(finding, null);
});

test("classifySevereTextOverflow reports a complete line clipped below a fixed box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [
      { left: 0, right: 280, top: 0, bottom: 20, width: 280, height: 20 },
      { left: 0, right: 250, top: 24, bottom: 44, width: 250, height: 20 },
    ],
    box: { left: 0, right: 300, top: 0, bottom: 22 },
    overflowX: "hidden",
    overflowY: "hidden",
  });

  assert.deepEqual(finding, { axis: "vertical", kind: "clipped-text", overflowPx: 22 });
});

test("classifySevereTextOverflow reports a wrapped label spilling beyond its visible box", () => {
  const finding = classifySevereTextOverflow({
    fragments: [
      { left: 4, right: 56, top: 2, bottom: 18, width: 52, height: 16 },
      { left: 4, right: 54, top: 20, bottom: 36, width: 50, height: 16 },
    ],
    box: { left: 0, right: 62, top: 0, bottom: 24 },
    overflowX: "visible",
    overflowY: "visible",
  });

  assert.deepEqual(finding, { axis: "vertical", kind: "clipped-text", overflowPx: 12 });
});

test("classifySevereTextOverflow suppresses explicit truncation and visually hidden accessibility text", () => {
  const base = {
    fragments: [{ left: 0, right: 300, top: 0, bottom: 20, width: 300, height: 20 }],
    box: { left: 0, right: 120, top: 0, bottom: 20 },
    overflowX: "hidden",
    overflowY: "hidden",
  };

  assert.equal(classifySevereTextOverflow({ ...base, isTruncated: true }), null);
  assert.equal(classifySevereTextOverflow({ ...base, isVisuallyHidden: true }), null);
});

test("classifyMaterialRectEscape detects both clipped starts and ends", () => {
  assert.deepEqual(
    classifyMaterialRectEscape({
      rect: { left: -30, right: 70, top: 0, bottom: 40, width: 100, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
      axes: ["horizontal"],
    }),
    { axis: "horizontal", side: "start", overflowPx: 30 },
  );
  assert.deepEqual(
    classifyMaterialRectEscape({
      rect: { left: 350, right: 430, top: 0, bottom: 40, width: 80, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
      axes: ["horizontal"],
    }),
    { axis: "horizontal", side: "end", overflowPx: 40 },
  );
});

test("classifyMaterialRectEscape suppresses tiny boundary excursions", () => {
  assert.equal(
    classifyMaterialRectEscape({
      rect: { left: -2, right: 98, top: 0, bottom: 40, width: 100, height: 40 },
      boundary: { left: 0, right: 390, top: 0, bottom: 844 },
    }),
    null,
  );
});

test("isMaterialPageOverflow requires a material escape containing meaningful content", () => {
  assert.equal(isMaterialPageOverflow({ overflowPx: 5, viewportWidth: 390, hasEscapedContent: true }), false);
  assert.equal(isMaterialPageOverflow({ overflowPx: 252, viewportWidth: 390, hasEscapedContent: false }), false);
  assert.equal(isMaterialPageOverflow({ overflowPx: 252, viewportWidth: 390, hasEscapedContent: true }), true);
});

test("findStableLayoutFindings keeps only severe roots present in both samples", () => {
  const first = [
    { selector: "html", kind: "page-horizontal-overflow", axis: "horizontal", severity: "error" },
    { selector: ".moving", kind: "clipped-text", axis: "horizontal", severity: "error" },
  ];
  const second = [
    { selector: "html", kind: "page-horizontal-overflow", axis: "horizontal", severity: "error" },
    { selector: ".late", kind: "clipped-text", axis: "vertical", severity: "error" },
  ];

  assert.deepEqual(findStableLayoutFindings(first, second), [second[0]]);
});

test("isNearTotalOcclusion requires enough samples and at least ninety percent coverage", () => {
  assert.equal(isNearTotalOcclusion({ occludedSamples: 9, totalSamples: 10 }), true);
  assert.equal(isNearTotalOcclusion({ occludedSamples: 8, totalSamples: 10 }), false);
  assert.equal(isNearTotalOcclusion({ occludedSamples: 4, totalSamples: 4 }), false);
});
