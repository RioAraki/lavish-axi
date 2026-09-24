import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore, slugForFile, uniqueSlug } from "../src/session-store.js";

test("opened_at marks first open and survives re-opens that bump updated_at", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const first = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    assert.ok(Number.isFinite(Date.parse(first.opened_at)));

    await new Promise((resolve) => setTimeout(resolve, 2));
    const reopened = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    assert.equal(reopened.opened_at, first.opened_at);
    assert.notEqual(reopened.updated_at, first.opened_at);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteSession removes the session and returns it, or null when unknown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    const removed = await store.deleteSession(session.key);
    assert.equal(removed.key, session.key);
    assert.equal(await store.findByKey(session.key), null);
    assert.deepEqual(await store.listSessions(), []);
    assert.equal(await store.deleteSession(session.key), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("slugForFile turns artifact file names into readable slugs", async () => {
  assert.equal(slugForFile("/tmp/plans/Q3 Roadmap.html"), "q3-roadmap");
  assert.equal(slugForFile("/tmp/plans/Q3 Roadmap.HTM"), "q3-roadmap");
  assert.equal(slugForFile("/tmp/artifact.html"), "artifact");
  assert.equal(slugForFile("/tmp/--weird__name!!.html"), "weird-name");
  assert.equal(slugForFile("/tmp/a  b.html"), "a-b");
  assert.equal(slugForFile("/tmp/report.v2.html"), "report-v2");
  assert.equal(slugForFile("/tmp/....html"), "session");
  assert.equal(slugForFile(""), "session");
  assert.equal(slugForFile("/tmp/设计稿.html"), "session");
});

test("uniqueSlug appends a counter for other sessions but lets a session re-mint its own base", async () => {
  const sessions = {
    aaa: { key: "aaa", slug: "plan" },
    bbb: { key: "bbb", slug: "plan-2" },
    ccc: { key: "ccc" },
  };

  assert.equal(uniqueSlug("plan", "ddd", sessions), "plan-3");
  assert.equal(uniqueSlug("plan", "aaa", sessions), "plan");
  assert.equal(uniqueSlug("plan-2", "bbb", sessions), "plan-2");
  assert.equal(uniqueSlug("fresh", "ddd", sessions), "fresh");
  assert.equal(uniqueSlug("plan", "ddd", {}), "plan");
});

test("sessions get a stable slug that findBySlug resolves", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const nested = path.join(dir, "nested");
    await mkdir(nested);
    const artifact = path.join(dir, "Launch Plan.html");
    const twin = path.join(nested, "launch plan.html");
    await writeFile(artifact, "<h1>Hello</h1>");
    await writeFile(twin, "<h1>Twin</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, (slug) => `http://localhost:4387/session/${slug}`);
    assert.equal(session.slug, "launch-plan");
    assert.equal(session.url, "http://localhost:4387/session/launch-plan");

    const other = await store.upsertSession(twin, (slug) => `http://localhost:4387/session/${slug}`);
    assert.equal(other.slug, "launch-plan-2");

    const found = await store.findBySlug("launch-plan");
    assert.equal(found.key, session.key);
    assert.equal((await store.findBySlug("launch-plan-2")).key, other.key);
    assert.equal(await store.findBySlug("nope"), null);
    assert.equal(await store.findBySlug(""), null);

    // Re-opening keeps the slug it was first given.
    const reopened = await store.upsertSession(artifact, (slug) => `http://localhost:4387/session/${slug}`);
    assert.equal(reopened.slug, "launch-plan");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("upsertSession stores a plain url string verbatim", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/legacy");

    assert.equal(session.url, "http://localhost:4387/session/legacy");
    assert.equal(session.slug, "artifact");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setFavorite marks a session and re-opens keep the mark", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    assert.equal(session.favorite, undefined);

    const marked = await store.setFavorite(session.key, true);
    assert.equal(marked.favorite, true);
    assert.equal((await store.findByKey(session.key)).favorite, true);

    // A re-open must not silently unprotect a favorited page from the prune.
    const reopened = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    assert.equal(reopened.favorite, true);

    // Unmarking drops the field entirely rather than storing `false`.
    const cleared = await store.setFavorite(session.key, false);
    assert.equal("favorite" in cleared, false);
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).sessions[session.key].favorite, undefined);

    assert.equal(await store.setFavorite("deadbeefdeadbeef", true), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
