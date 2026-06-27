# pi-code-context

Automatic semantic code indexing for [pi](https://pi.dev). It keeps every
project's vector index fresh in the background and exposes a real CLI for
indexing and search.

The package is **fully standalone** — there is no background server to run. It
bundles a thin CLI that reuses the indexing engine from the
[`@mhalder/qdrant-mcp-server`](https://www.npmjs.com/package/@mhalder/qdrant-mcp-server)
npm package as a plain library, calling it **directly**. Indexing, the
agent-callable `search_code` tool, and the slash commands all run through the
bundled CLI, talking straight to Qdrant + Ollama.

Collection naming follows the same scheme that npm package uses
(git-remote/abspath → `code_<hash8>`), so indexes are interchangeable with any
other tooling built on the same engine.

## How it works

- **Vector store:** Qdrant (`QDRANT_URL`, default `http://localhost:6333`)
- **Embeddings:** Ollama (`EMBEDDING_MODEL`, default `nomic-embed-text`, via
  `EMBEDDING_BASE_URL`, default `http://localhost:11434`)
- **Collection naming:** git-remote URL (or absolute path) → `code_<md5[:8]>`.

The extension runs `code-context auto` on session start for any real project
(detected via `.git`, `package.json`, `go.mod`, `Cargo.toml`, `AGENTS.md`, …):
full index on first run, incremental reindex afterwards. It is debounced
per-repo (10 min), skips when Qdrant/Ollama are unreachable, and is always
fire-and-forget — it never blocks the agent.

## Prerequisites

1. **Qdrant** running locally:
   ```bash
   docker run -p 6333:6333 qdrant/qdrant
   ```
2. **Ollama** with an embedding model:
   ```bash
   ollama pull nomic-embed-text
   ```
3. **Node 22–24** available. The bundled engine ships native tree-sitter
   modules requiring `>=22 <25`. The launcher auto-detects a compatible Node
   (Homebrew `node@22`/`node@24`, nvm, etc.). Override with
   `CODE_CONTEXT_NODE=/path/to/node`.

## Install

```bash
pi install git:github.com/renezander030/pi-code-context
```

This clones the package and runs `npm install`, which compiles the native
indexing engine for your platform.

To install for a single project (shared with your team via `.pi/settings.json`):

```bash
pi install -l git:github.com/renezander030/pi-code-context
```

## Commands

Inside pi:

| Command | Description |
|---|---|
| `/index` | Full index of the current project (`/index --force` to rebuild) |
| `/reindex` | Incremental reindex of changed files |
| `/index-status` | Show index status (collection, chunk count, last updated) |
| `/index-search <query>` | Semantic search over the project's index |

### Agent tool

The extension also registers a `search_code` tool the **LLM** can call directly
(natural-language query, optional `limit` / `fileTypes` / `pathPattern`),
backed entirely by the bundled CLI. The agent gets semantic search with no
server to run.

## CLI

The bundled `code-context` binary is also usable standalone (scripts, hooks, CI):

```bash
code-context index   [path] [--force] [--ext .ts,.go] [--ignore PATTERN]
code-context reindex [path]                 # incremental, changed files only
code-context auto    [path]                 # index if missing, else reindex
code-context search  [path] <query> [--limit N] [--types .ts,.py] [--glob GLOB] [--json]
code-context status  [path] [--json]
code-context clear   [path] --yes
code-context doctor                         # check Qdrant + Ollama + model
```

`path` defaults to the current directory.

To put it on your PATH:

```bash
ln -s "$(pi list --paths 2>/dev/null | grep pi-code-context)/bin/code-context" ~/.local/bin/code-context
# or just symlink from the cloned package directory's bin/code-context
```

## Configuration

All via environment variables:

| Var | Default | Purpose |
|---|---|---|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint |
| `QDRANT_API_KEY` | – | Qdrant API key (if secured) |
| `EMBEDDING_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `CODE_CONTEXT_NODE` | auto | Path to a Node 22–24 binary |
| `CODE_CONTEXT_DEBUG` | – | Set to see engine debug logs |

## License

MIT
