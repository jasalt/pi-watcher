#!/usr/bin/env node
// Claude Code plugin monitor: watch source files for AI marker comments.
//
// Emits one stdout line per newly seen marker; Claude Code delivers each
// line to the session as an async notification. Zero runtime dependencies
// so the plugin works without an npm install step (the pi extension in
// src/ keeps its chokidar-based watcher; this monitor is the Claude port).
//
// Markers (uppercase only, inside #, //, --, or ; line comments):
//   AI!  change request — act on it
//   AI?  question — answer it
//   AI.  note — acknowledge/remember it
//
// Usage: node watch-markers.mjs [rootDir]
// Env:   WATCH_MARKERS_SCAN_ON_START=0  disable the initial full scan
//        WATCH_MARKERS_DEBOUNCE_MS      per-file debounce (default 750)

import { watch, promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] || process.cwd());
const DEBOUNCE_MS = Number(process.env.WATCH_MARKERS_DEBOUNCE_MS || 750);
const SCAN_ON_START = process.env.WATCH_MARKERS_SCAN_ON_START !== "0";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_STARTUP_REPORTS = 20;

const IGNORED_DIRS = new Set([
  ".git", ".jj", ".hg", "node_modules", "dist", "build", "target",
  "vendor", ".venv", "venv", ".agents", ".claude", ".pi", ".idea",
  "__pycache__", ".pytest_cache", "coverage",
]);

const MARKER_RE = /(?:#|\/\/|--|;)+\s*(?<text>[^\n]*?\bAI(?<intent>[!?.])[^\n]*)/;

const ACTION = {
  "!": "change request — act on it as a fast local edit, then remove the marker comment",
  "?": "question — answer it, then remove the marker comment",
  ".": "note — acknowledge and remember it for this session",
};

// file -> Set of "line:text" already reported, so edits re-report only new
// or changed markers and deletions free their keys.
const reported = new Map();
const timers = new Map();

function ignored(rel) {
  return rel.split(path.sep).some((part) => IGNORED_DIRS.has(part));
}

async function scanFile(rel, { quiet = false } = {}) {
  const abs = path.join(root, rel);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    reported.delete(rel); // deleted file
    return 0;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return 0;

  let buf;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return 0;
  }
  if (buf.subarray(0, 8192).includes(0)) return 0; // binary

  const seen = new Set();
  const fresh = [];
  const lines = buf.toString("utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_RE.exec(lines[i]);
    if (!m) continue;
    const key = `${i + 1}:${m.groups.text.trim()}`;
    seen.add(key);
    if (!reported.get(rel)?.has(key)) fresh.push({ line: i + 1, ...m.groups });
  }
  reported.set(rel, seen);

  if (!quiet) {
    for (const f of fresh) {
      console.log(
        `[watcher] AI${f.intent} ${rel}:${f.line} — "${f.text.trim()}" → ${ACTION[f.intent]}.`,
      );
    }
  }
  return seen.size;
}

async function scanTree(dir, found = { count: 0 }) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found.count;
  }
  for (const e of entries) {
    const rel = path.relative(root, path.join(dir, e.name));
    if (ignored(rel)) continue;
    if (e.isDirectory()) await scanTree(path.join(dir, e.name), found);
    else if (e.isFile() && found.count < MAX_STARTUP_REPORTS)
      found.count += await scanFile(rel);
  }
  return found.count;
}

function onChange(rel) {
  clearTimeout(timers.get(rel));
  timers.set(
    rel,
    setTimeout(() => {
      timers.delete(rel);
      scanFile(rel).catch(() => {});
    }, DEBOUNCE_MS),
  );
}

if (SCAN_ON_START) await scanTree(root);

watch(root, { recursive: true }, (_event, filename) => {
  if (!filename) return;
  const rel = filename.toString();
  if (!ignored(rel)) onChange(rel);
});
