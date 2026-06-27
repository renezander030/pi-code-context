#!/usr/bin/env node
/**
 * code-context — a true CLI for pi codebase indexing.
 *
 * Reuses the *exact* indexing engine from @mhalder/qdrant-mcp-server (the same
 * package the pi MCP integration uses), but drives it directly instead of over
 * the MCP stdio protocol. This makes indexing scriptable from hooks, cron, CI,
 * and pi extensions without spinning up an MCP server.
 *
 * Backends:
 *   - Qdrant     (vector store)   QDRANT_URL        default http://localhost:6333
 *   - Ollama     (embeddings)     EMBEDDING_MODEL   default nomic-embed-text
 *
 * Collection naming is identical to the MCP server (git-remote md5 or abspath
 * md5 → code_<hash8>), so the CLI and the MCP `search_code` tool share indexes.
 *
 * Commands:
 *   code-context index   [path] [--force] [--ext .ts,.go] [--ignore PATTERN]
 *   code-context reindex [path]                 incremental: changed files only
 *   code-context search  [path] <query...> [--limit N] [--types .ts,.py] [--glob GLOB]
 *   code-context status  [path] [--json]
 *   code-context clear   [path] [--yes]
 *   code-context auto    [path]                 index if absent, else reindex
 *   code-context doctor                         check qdrant + ollama reachability
 *
 * `path` defaults to the current working directory.
 */

import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

// Silence the engine's pino logger (read at import time) unless debugging.
if (!process.env.CODE_CONTEXT_DEBUG) {
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || "silent";
}

// Resolve the engine relative to this file's node_modules so the CLI works no
// matter where it's invoked from.
const pkgRoot = resolve(
  require.resolve("@mhalder/qdrant-mcp-server/package.json"),
  "..",
);

const { CodeIndexer } = await import(`${pkgRoot}/build/code/indexer.js`);
const { QdrantManager } = await import(`${pkgRoot}/build/qdrant/client.js`);
const { EmbeddingProviderFactory } = await import(
  `${pkgRoot}/build/embeddings/factory.js`
);
const cfg = await import(`${pkgRoot}/build/code/config.js`);

// ── Config (env, matching the MCP server defaults) ──────────────────────────
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const OLLAMA_URL = process.env.EMBEDDING_BASE_URL || "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text";

// ── Tiny arg parser ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function csv(v) {
  if (!v || v === true) return undefined;
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Engine wiring ───────────────────────────────────────────────────────────
function makeIndexer() {
  const qdrant = new QdrantManager(QDRANT_URL, QDRANT_API_KEY);
  const embeddings = EmbeddingProviderFactory.create({
    provider: "ollama",
    model: EMBEDDING_MODEL,
    baseUrl: OLLAMA_URL,
  });
  const codeConfig = {
    chunkSize: parseInt(process.env.CODE_CHUNK_SIZE || String(cfg.DEFAULT_CHUNK_SIZE), 10),
    chunkOverlap: parseInt(process.env.CODE_CHUNK_OVERLAP || String(cfg.DEFAULT_CHUNK_OVERLAP), 10),
    enableASTChunking: process.env.CODE_ENABLE_AST !== "false",
    supportedExtensions: cfg.DEFAULT_CODE_EXTENSIONS,
    ignorePatterns: cfg.DEFAULT_IGNORE_PATTERNS,
    batchSize: parseInt(process.env.CODE_BATCH_SIZE || String(cfg.DEFAULT_BATCH_SIZE), 10),
    defaultSearchLimit: parseInt(process.env.CODE_SEARCH_LIMIT || String(cfg.DEFAULT_SEARCH_LIMIT), 10),
    enableHybridSearch: process.env.CODE_ENABLE_HYBRID === "true",
  };
  return { qdrant, indexer: new CodeIndexer(qdrant, embeddings, codeConfig) };
}

// ── stderr progress bar (keeps stdout clean for scripting) ──────────────────
function progressLogger() {
  let last = -1;
  return (p) => {
    if (!process.stderr.isTTY) return;
    const pct = Math.round(p.percentage ?? 0);
    if (pct === last) return;
    last = pct;
    const width = 24;
    const filled = Math.round((pct / 100) * width);
    const bar = "█".repeat(filled) + "░".repeat(width - filled);
    process.stderr.write(`\r  [${bar}] ${String(pct).padStart(3)}%  ${p.phase ?? ""}: ${p.message ?? ""}`.padEnd(80));
    if (pct >= 100) process.stderr.write("\n");
  };
}

function die(msg) {
  console.error(`code-context: ${msg}`);
  process.exit(1);
}

// ── Commands ────────────────────────────────────────────────────────────────
async function cmdIndex(path, flags) {
  const { indexer } = makeIndexer();
  const stats = await indexer.indexCodebase(
    path,
    {
      forceReindex: !!(flags.force || flags.f),
      extensions: csv(flags.ext),
      ignorePatterns: csv(flags.ignore),
    },
    progressLogger(),
  );
  if (stats.status === "failed") {
    console.error(`Indexing failed:\n${(stats.errors || []).join("\n")}`);
    process.exit(1);
  }
  let msg = `Indexed ${stats.filesIndexed}/${stats.filesScanned} files (${stats.chunksCreated} chunks) in ${(stats.durationMs / 1000).toFixed(1)}s`;
  if (stats.status === "partial") msg += `\nWarnings:\n${(stats.errors || []).join("\n")}`;
  console.log(msg);
}

async function cmdReindex(path) {
  const { indexer } = makeIndexer();
  const status = await indexer.getIndexStatus(path);
  if (status.status === "not_indexed") {
    console.error(`Not indexed yet. Run: code-context index "${path}"`);
    process.exit(1);
  }
  const stats = await indexer.reindexChanges(path, progressLogger());
  if (stats.filesAdded === 0 && stats.filesModified === 0 && stats.filesDeleted === 0) {
    console.log("No changes detected. Codebase is up to date.");
    return;
  }
  console.log(
    `Re-index complete: +${stats.filesAdded} added, ~${stats.filesModified} modified, -${stats.filesDeleted} deleted, ${stats.chunksAdded} chunks, ${(stats.durationMs / 1000).toFixed(1)}s`,
  );
}

async function cmdSearch(path, query, flags) {
  if (!query) die("search requires a query, e.g. code-context search . 'auth logic'");
  const { indexer } = makeIndexer();
  const results = await indexer.searchCode(path, query, {
    limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
    fileTypes: csv(flags.types),
    pathPattern: flags.glob && flags.glob !== true ? String(flags.glob) : undefined,
  });
  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (!results.length) {
    console.log(`No results for: "${query}"`);
    return;
  }
  console.log(`Found ${results.length} result(s):`);
  for (const [i, r] of results.entries()) {
    console.log(`\n--- ${i + 1} (score ${r.score.toFixed(3)}) ${r.filePath}:${r.startLine}-${r.endLine} [${r.language}] ---`);
    console.log(r.content);
  }
}

async function cmdStatus(path, flags) {
  const { indexer } = makeIndexer();
  const status = await indexer.getIndexStatus(path);
  if (flags.json) {
    console.log(JSON.stringify({ path: resolve(path), ...status }, null, 2));
    return;
  }
  if (status.status === "not_indexed") {
    console.log(`not indexed: ${resolve(path)}`);
    process.exit(2);
  }
  console.log(JSON.stringify(status, null, 2));
}

async function cmdClear(path, flags) {
  if (!(flags.yes || flags.y)) die(`refusing to clear without --yes (target: ${resolve(path)})`);
  const { indexer } = makeIndexer();
  await indexer.clearIndex(path);
  console.log(`Index cleared for: ${resolve(path)}`);
}

async function cmdAuto(path) {
  const { indexer } = makeIndexer();
  const status = await indexer.getIndexStatus(path);
  if (status.status === "not_indexed") {
    console.error(`No index found — running full index of ${resolve(path)}`);
    return cmdIndex(path, {});
  }
  return cmdReindex(path);
}

async function cmdDoctor() {
  const checks = [];
  // Qdrant
  try {
    const r = await fetch(`${QDRANT_URL}/collections`, {
      headers: QDRANT_API_KEY ? { "api-key": QDRANT_API_KEY } : {},
    });
    const j = await r.json();
    const cols = (j.result?.collections || []).map((c) => c.name);
    checks.push(["qdrant", r.ok, `${QDRANT_URL} (${cols.length} collections)`]);
  } catch (e) {
    checks.push(["qdrant", false, `${QDRANT_URL} — ${e.message}`]);
  }
  // Ollama + model
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const j = await r.json();
    const models = (j.models || []).map((m) => m.name);
    const has = models.some((m) => m === EMBEDDING_MODEL || m.startsWith(EMBEDDING_MODEL + ":"));
    checks.push(["ollama", r.ok, `${OLLAMA_URL} (${models.length} models)`]);
    checks.push(["embed-model", has, `${EMBEDDING_MODEL}${has ? "" : " — NOT pulled; run: ollama pull " + EMBEDDING_MODEL}`]);
  } catch (e) {
    checks.push(["ollama", false, `${OLLAMA_URL} — ${e.message}`]);
  }
  let ok = true;
  for (const [name, pass, detail] of checks) {
    if (!pass) ok = false;
    console.log(`${pass ? "✓" : "✗"} ${name.padEnd(12)} ${detail}`);
  }
  process.exit(ok ? 0 : 1);
}

function usage() {
  console.log(`code-context — true CLI for pi codebase indexing (Qdrant + Ollama)

Usage:
  code-context index   [path] [--force] [--ext .ts,.go] [--ignore '**/gen/**']
  code-context reindex [path]
  code-context search  [path] <query...> [--limit N] [--types .ts,.py] [--glob 'src/**'] [--json]
  code-context status  [path] [--json]
  code-context clear   [path] --yes
  code-context auto    [path]      # index if missing, else incremental reindex
  code-context doctor

path defaults to the current directory.

Env: QDRANT_URL=${QDRANT_URL}  EMBEDDING_MODEL=${EMBEDDING_MODEL}  EMBEDDING_BASE_URL=${OLLAMA_URL}`);
}

// ── Dispatch ────────────────────────────────────────────────────────────────
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (!cmd || cmd === "help" || flags.help || flags.h) return usage();
  if (cmd === "doctor") return cmdDoctor();

  // For search: first positional may be a path, remaining join as query.
  // Heuristic: if first positional exists as a dir or is "." / starts with / or ./, treat as path.
  const cwd = process.cwd();

  switch (cmd) {
    case "index":
      return cmdIndex(positional[0] || cwd, flags);
    case "reindex":
      return cmdReindex(positional[0] || cwd);
    case "auto":
      return cmdAuto(positional[0] || cwd);
    case "status":
      return cmdStatus(positional[0] || cwd, flags);
    case "clear":
      return cmdClear(positional[0] || cwd, flags);
    case "search": {
      // Decide whether positional[0] is a path or part of the query.
      let path = cwd;
      let queryParts = positional;
      const first = positional[0];
      if (first && (first === "." || first.startsWith("/") || first.startsWith("./") || first.startsWith("~"))) {
        path = first;
        queryParts = positional.slice(1);
      }
      return cmdSearch(path, queryParts.join(" "), flags);
    }
    default:
      die(`unknown command "${cmd}". Run: code-context help`);
  }
}

main().catch((e) => {
  console.error(`code-context: ${e?.stack || e?.message || e}`);
  process.exit(1);
});
