/**
 * pi-code-context
 *
 * Keeps every pi project's semantic code index fresh automatically, using a
 * bundled `code-context` CLI that wraps the @mhalder/qdrant-mcp-server indexing
 * engine (Qdrant vector store + Ollama embeddings).
 *
 * The CLI shares collection naming with the `code-context` MCP `search_code`
 * tool (git-remote/abspath -> code_<hash8>), so anything indexed here is
 * immediately searchable from the MCP tool, and vice versa.
 *
 * Behaviour:
 *   - On session start, for a real project (git repo or recognised manifest),
 *     run `code-context auto` in the background: full index on first run,
 *     incremental reindex afterwards. Debounced per-repo.
 *   - Skips when backends are down, the cwd is not a project, or it ran too
 *     recently (REINDEX_MIN_INTERVAL_MS).
 *   - Commands: /index, /reindex, /index-status, /index-search <query>.
 *
 * Everything is best-effort and silent on failure; it never blocks the agent.
 *
 * Config via env (same names the MCP server uses):
 *   QDRANT_URL          default http://localhost:6333
 *   EMBEDDING_BASE_URL  default http://localhost:11434  (Ollama)
 *   EMBEDDING_MODEL     default nomic-embed-text
 *   CODE_CONTEXT_NODE   path to a Node 22-24 binary, if your default node is incompatible
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Locate the bundled CLI launcher (relative to this file) ────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
// extensions/index.ts -> ../bin/code-context
const CLI = join(__dirname, "..", "bin", "code-context");

// ── Config ──────────────────────────────────────────────────────────────────
const STATE_FILE = join(homedir(), ".pi", "code_context_state.json");
const STATE_DIR = join(homedir(), ".pi");

const REINDEX_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const DOCTOR_TTL_MS = 60 * 1000;

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const OLLAMA_URL = process.env.EMBEDDING_BASE_URL || "http://localhost:11434";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "Gemfile",
  "composer.json",
  "tsconfig.json",
  "AGENTS.md",
  ".pi",
];

// ── State ─────────────────────────────────────────────────────────────────
interface RepoState {
  lastRun: number;
}
interface CodeContextState {
  repos: Record<string, RepoState>;
}

function loadState(): CodeContextState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf8")) as CodeContextState;
    }
  } catch {
    /* ignore */
  }
  return { repos: {} };
}

function saveState(state: CodeContextState): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* non-fatal */
  }
}

function repoKey(cwd: string): string {
  return createHash("md5").update(cwd).digest("hex").slice(0, 12);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function cliAvailable(): boolean {
  return existsSync(CLI);
}

function looksLikeProject(cwd: string): boolean {
  return PROJECT_MARKERS.some((m) => existsSync(join(cwd, m)));
}

let doctorCache: { ts: number; ok: boolean } | null = null;
async function backendsUp(): Promise<boolean> {
  const now = Date.now();
  if (doctorCache && now - doctorCache.ts < DOCTOR_TTL_MS) return doctorCache.ok;
  let ok = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const [q, o] = await Promise.all([
      fetch(`${QDRANT_URL}/healthz`, { signal: ctrl.signal }).catch(() =>
        fetch(`${QDRANT_URL}/collections`, { signal: ctrl.signal }),
      ),
      fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl.signal }),
    ]);
    clearTimeout(t);
    ok = !!q && q.ok && !!o && o.ok;
  } catch {
    ok = false;
  }
  doctorCache = { ts: now, ok };
  return ok;
}

// ── Extension ───────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  const state = loadState();

  // The CLI inherits pi's env (QDRANT_URL / EMBEDDING_MODEL / etc. when set)
  // and otherwise applies the same defaults this extension uses.
  async function runCli(args: string[], cwd: string) {
    return pi.exec(CLI, args, { cwd, timeout: 10 * 60 * 1000 });
  }

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    if (!cliAvailable()) return;
    if (!looksLikeProject(cwd)) return;

    const key = repoKey(cwd);
    const last = state.repos[key]?.lastRun ?? 0;
    if (Date.now() - last < REINDEX_MIN_INTERVAL_MS) return;

    if (!(await backendsUp())) return;

    // Mark immediately so concurrent sessions don't double-run.
    state.repos[key] = { lastRun: Date.now() };
    saveState(state);

    // Fire-and-forget; never block startup.
    void (async () => {
      try {
        const status = await runCli(["status", cwd, "--json"], cwd);
        const fresh = status.code === 0; // exit 2 = not indexed
        ctx.ui.setStatus("code-context", fresh ? "↻ reindexing…" : "⊕ indexing…");
        const res = await runCli(["auto", cwd], cwd);
        const line = (res.stdout || res.stderr || "").trim().split("\n").pop() || "";
        ctx.ui.setStatus("code-context", undefined);
        if (line && ctx.hasUI) ctx.ui.notify(`code-context: ${line}`, "info");
      } catch {
        ctx.ui.setStatus("code-context", undefined);
      }
    })();
  });

  pi.registerCommand("index", {
    description: "Index this project for semantic code search (code-context CLI)",
    handler: async (args, ctx) => {
      if (!cliAvailable()) return ctx.ui.notify("code-context CLI not found at " + CLI, "error");
      const force = args.trim() === "--force";
      ctx.ui.setStatus("code-context", "indexing…");
      try {
        const res = await runCli(force ? ["index", ctx.cwd, "--force"] : ["index", ctx.cwd], ctx.cwd);
        state.repos[repoKey(ctx.cwd)] = { lastRun: Date.now() };
        saveState(state);
        ctx.ui.notify(`code-context: ${(res.stdout || res.stderr).trim()}`, res.code === 0 ? "info" : "error");
      } catch (e) {
        ctx.ui.notify(`code-context index failed: ${(e as Error).message}`, "error");
      } finally {
        ctx.ui.setStatus("code-context", undefined);
      }
    },
  });

  pi.registerCommand("reindex", {
    description: "Incrementally reindex changed files (code-context CLI)",
    handler: async (_args, ctx) => {
      if (!cliAvailable()) return ctx.ui.notify("code-context CLI not found", "error");
      ctx.ui.setStatus("code-context", "reindexing…");
      try {
        const res = await runCli(["auto", ctx.cwd], ctx.cwd);
        state.repos[repoKey(ctx.cwd)] = { lastRun: Date.now() };
        saveState(state);
        ctx.ui.notify(`code-context: ${(res.stdout || res.stderr).trim()}`, "info");
      } catch (e) {
        ctx.ui.notify(`code-context reindex failed: ${(e as Error).message}`, "error");
      } finally {
        ctx.ui.setStatus("code-context", undefined);
      }
    },
  });

  pi.registerCommand("index-status", {
    description: "Show this project's code-context index status",
    handler: async (_args, ctx) => {
      if (!cliAvailable()) return ctx.ui.notify("code-context CLI not found", "error");
      try {
        const res = await runCli(["status", ctx.cwd, "--json"], ctx.cwd);
        ctx.ui.notify((res.stdout || res.stderr).trim(), "info");
      } catch (e) {
        ctx.ui.notify(`code-context status failed: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("index-search", {
    description: "Semantic code search over this project's index",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) return ctx.ui.notify("usage: /index-search <query>", "warning");
      if (!cliAvailable()) return ctx.ui.notify("code-context CLI not found", "error");
      try {
        const res = await runCli(["search", ctx.cwd, query, "--limit", "5"], ctx.cwd);
        ctx.ui.notify((res.stdout || res.stderr).trim() || "no results", "info");
      } catch (e) {
        ctx.ui.notify(`code-context search failed: ${(e as Error).message}`, "error");
      }
    },
  });
}
