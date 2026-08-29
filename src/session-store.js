import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

// A session is just "this artifact file is being displayed at this URL". There is no
// review state to track: Lavish renders the artifact and the agent moves on, so the
// record carries identity (key/file/slug/url) and timestamps and nothing else.
export class SessionStore {
  constructor(file) {
    this.file = file;
  }

  async listSessions() {
    const state = await this.readState();
    return Object.values(state.sessions).sort((a, b) => a.file.localeCompare(b.file));
  }

  async findByFile(file) {
    const absolute = await canonicalFile(file);
    const state = await this.readState();
    return state.sessions[sessionKey(absolute)] || null;
  }

  async findByKey(key) {
    const state = await this.readState();
    return state.sessions[key] || null;
  }

  // Slugs are a readable alias for the sha256 key in session URLs only; every other route
  // (chrome, /artifact, /events) still addresses sessions by key.
  async findBySlug(slug) {
    const wanted = String(slug || "");
    if (!wanted) return null;
    const state = await this.readState();
    return Object.values(state.sessions).find((session) => session.slug === wanted) || null;
  }

  async deleteSession(key) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) return null;
    delete state.sessions[key];
    await this.writeState(state);
    return session;
  }

  // `url` may be a builder `(slug, key) => string` for callers that need the slug the store
  // just minted; a plain string is stored verbatim. Fields written by older releases (prompts,
  // chat, status, ...) are dropped on the next upsert rather than migrated - nothing reads them.
  async upsertSession(file, url) {
    const absolute = await canonicalFile(file);
    const key = sessionKey(absolute);
    const state = await this.readState();
    const existing = state.sessions[key] || {};
    // Stable per file: a re-open keeps the slug it was first given, so previously shared
    // session links keep resolving even after sibling sessions come and go.
    const slug = existing.slug || uniqueSlug(slugForFile(absolute), key, state.sessions);
    const session = {
      key,
      file: absolute,
      slug,
      url: typeof url === "function" ? url(slug, key) : url,
      // First-open time. Unlike `updated_at` this is never bumped by a re-open, so the session
      // index can show (and prune by) how old a session really is.
      opened_at: existing.opened_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    state.sessions[key] = session;
    await this.writeState(state);
    return session;
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { sessions: {} };
      }
      throw error;
    }
  }

  async writeState(state) {
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export async function canonicalFile(file) {
  const absolute = path.resolve(file);
  return realpath(absolute);
}

export function sessionKey(file) {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
}

// Readable stem for a session URL: "~/plans/Q3 Roadmap.html" -> "q3-roadmap". Only the file
// name participates, so the slug stays short enough to read in a browser address bar.
export function slugForFile(file) {
  const base = path
    .basename(String(file || ""))
    .toLowerCase()
    .replace(/\.html?$/, "");
  const slug = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "session";
}

// Two artifacts in different folders can share a file name, so a taken base gets -2, -3, ...
// The session re-minting its own base keeps it (its own key is excluded from the conflict scan).
export function uniqueSlug(base, key, sessions) {
  const taken = new Set(
    Object.values(sessions || {})
      .filter((session) => session && session.key !== key && session.slug)
      .map((session) => session.slug),
  );
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
