// server.ts — минимальный API для viewer.
//
// Endpoints:
//   GET /api/tree                — дерево документов по слоям KB
//   GET /api/doc/<path>          — markdown + parsed frontmatter + backlinks
//   GET /api/graph               — nodes + edges из таблицы links (если есть индекс)
//   GET /api/search?q=...&mode=  — hybrid search через scripts/semantic
//   GET /api/health              — sanity
//
// Запуск:  pnpm dev:server (порт 3001)
// Конфиг:  переменные среды VIEWER_PORT, REPO_ROOT (по умолчанию ../../, т.е. корень шаблона).

import { createServer } from "node:http";
import { readFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import matter from "gray-matter";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(process.env.REPO_ROOT || join(__dirname, "..", ".."));
const PORT = Number(process.env.VIEWER_PORT) || 3001;
// Безопасность: по умолчанию слушаем только loopback. Для доступа из сети
// явно задайте VIEWER_HOST=0.0.0.0 (на свой риск — API читает файлы и спавнит node).
const HOST = process.env.VIEWER_HOST || "127.0.0.1";

// Слои KB. Подстройте под свой проект (должны совпадать с INDEXABLE_LAYERS в scripts/semantic/lib.mjs).
const INDEXABLE_LAYERS = [
  "00_context",
  "02_sources",
  "03_wiki",
  "04_synthesis",
  "05_decisions",
  "06_outputs",
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".context", ".remember", ".claude"]);

// ---------- helpers ----------

async function walkLayer(layer: string): Promise<string[]> {
  const root = join(REPO_ROOT, layer);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && extname(e.name) === ".md") out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

type DocMeta = {
  path: string;
  layer: string;
  name: string;
  size: number;
  mtime: number;
  title: string | null;
  frontmatter: Record<string, unknown>;
};

async function readDocMeta(abs: string, layer: string): Promise<DocMeta | null> {
  try {
    const st = await stat(abs);
    const raw = await readFile(abs, "utf8");
    const { data, content } = matter(raw);
    const firstH1 = content.split("\n").find((l) => /^#\s+\S/.test(l));
    const title =
      (typeof data.title === "string" && data.title) ||
      (firstH1 ? firstH1.replace(/^#\s+/, "").trim() : null);
    return {
      path: relative(REPO_ROOT, abs),
      layer,
      name: abs.split("/").pop() || "",
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
      title,
      frontmatter: data,
    };
  } catch {
    return null;
  }
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res: import("node:http").ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

// ---------- handlers ----------

async function handleTree(): Promise<unknown> {
  const tree: Record<string, DocMeta[]> = {};
  for (const layer of INDEXABLE_LAYERS) {
    const files = await walkLayer(layer);
    const docs: DocMeta[] = [];
    for (const f of files) {
      const meta = await readDocMeta(f, layer);
      if (meta) docs.push(meta);
    }
    tree[layer] = docs;
  }
  return { layers: INDEXABLE_LAYERS, tree, builtAt: Date.now() };
}

async function handleDoc(relPath: string): Promise<unknown | null> {
  // Безопасность: отдаём ТОЛЬКО .md строго внутри REPO_ROOT.
  // resolve() нормализует "..", relative() ловит выход за корень; dot-сегменты
  // (.git/.claude/.remember/.context) запрещены полностью.
  const safe = relPath.replace(/^\/+/, "");
  if (extname(safe) !== ".md") return null;
  const abs = resolve(REPO_ROOT, safe);
  const rel = relative(REPO_ROOT, abs);
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) return null;
  if (rel.split("/").some((seg) => seg.startsWith("."))) return null;
  if (!existsSync(abs)) return null;
  const raw = await readFile(abs, "utf8");
  const { data, content } = matter(raw);
  const layerMatch = rel.match(/^([^/]+)\//);
  const layer = layerMatch ? layerMatch[1] : "";
  // backlinks через sqlite-индекс, если он есть
  const backlinks = await loadBacklinks(rel);
  return {
    path: rel,
    layer,
    raw,
    body: content,
    frontmatter: data,
    backlinks,
  };
}

async function loadBacklinks(targetPath: string): Promise<string[]> {
  const dbPath = join(REPO_ROOT, ".semantic-index.sqlite");
  if (!existsSync(dbPath)) return [];
  try {
    // Динамический импорт — better-sqlite3 не должен быть hard-зависимостью viewer'а.
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare("SELECT src FROM links WHERE dst = ? ORDER BY src")
        .all(targetPath) as { src: string }[];
      return rows.map((r) => r.src);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

async function handleGraph(): Promise<unknown> {
  const dbPath = join(REPO_ROOT, ".semantic-index.sqlite");
  if (!existsSync(dbPath)) return { nodes: [], edges: [], hint: "no .semantic-index.sqlite" };
  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbPath, { readonly: true });
    try {
      const files = db.prepare("SELECT path FROM files ORDER BY path").all() as { path: string }[];
      const links = db.prepare("SELECT src, dst, type FROM links").all() as {
        src: string;
        dst: string;
        type: string;
      }[];
      const nodes = files.map((f) => ({
        id: f.path,
        label: f.path.split("/").pop() || f.path,
        layer: f.path.split("/")[0] || "",
      }));
      const fileSet = new Set(nodes.map((n) => n.id));
      const edges = links
        .filter((l) => fileSet.has(l.src))
        .map((l) => ({ source: l.src, target: l.dst, type: l.type }));
      return { nodes, edges };
    } finally {
      db.close();
    }
  } catch (e) {
    return { nodes: [], edges: [], error: String(e) };
  }
}

// ---------- skillopt endpoints (read-only) ----------

async function handleSkillOptRuns(limit: number): Promise<unknown> {
  const runsFile = join(REPO_ROOT, ".context", "skillopt", "runs.jsonl");
  if (!existsSync(runsFile)) return { runs: [], hint: "no .context/skillopt/runs.jsonl" };
  const raw = await readFile(runsFile, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const runs: unknown[] = [];
  for (let i = lines.length - 1; i >= 0 && runs.length < limit; i--) {
    try { runs.push(JSON.parse(lines[i])); } catch { /* skip */ }
  }
  return { runs };
}

async function handleSkillOptRunSummary(runId: string): Promise<unknown> {
  const summaryPath = join(REPO_ROOT, ".context", "skillopt", runId, "summary.json");
  if (!existsSync(summaryPath)) return null;
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  // Список traces
  const tracesDir = join(REPO_ROOT, ".context", "skillopt", runId, "traces");
  let traces: unknown[] = [];
  if (existsSync(tracesDir)) {
    const files = await readdir(tracesDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const t = JSON.parse(await readFile(join(tracesDir, f), "utf8"));
      traces.push({
        case_id: t.case_id, skill: t.skill, passed: t.passed,
        score: t.score, latency_ms: t.latency_ms, error: t.error,
        output_preview: t.output ? String(t.output).slice(0, 300) : null,
      });
    }
  }
  // Список proposals (если есть)
  const proposalsDir = join(REPO_ROOT, ".context", "skillopt", runId, "proposals");
  let proposals: string[] = [];
  if (existsSync(proposalsDir)) {
    const pFiles = await readdir(proposalsDir);
    proposals = pFiles
      .filter((f) => f.endsWith(".md") && !f.endsWith(".rationale.md"))
      .map((f) => f.replace(/\.md$/, ""));
  }
  return { runId, summary, traces, proposals };
}

function handleSearch(query: string, mode = "hybrid", top = 10): Promise<unknown> {
  return new Promise((res) => {
    const script = join(REPO_ROOT, "scripts", "semantic", "search.mjs");
    if (!existsSync(script)) return res({ error: "scripts/semantic/search.mjs not found" });
    const args = [script, query, "--mode", mode, "--top", String(top), "--json"];
    const proc = spawn("node", args, { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b) => (stdout += b.toString()));
    proc.stderr.on("data", (b) => (stderr += b.toString()));
    proc.on("close", (code) => {
      if (code !== 0) return res({ error: stderr || `exit ${code}` });
      try {
        res({ results: JSON.parse(stdout), query, mode, top });
      } catch (e) {
        res({ error: "parse error", raw: stdout.slice(0, 500) });
      }
    });
  });
}

// ---------- server ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  res.setHeader("Cache-Control", "no-store");
  try {
    if (url.pathname === "/api/health") return sendJson(res, 200, { ok: true, repo: REPO_ROOT });
    if (url.pathname === "/api/tree") return sendJson(res, 200, await handleTree());
    if (url.pathname === "/api/graph") return sendJson(res, 200, await handleGraph());
    if (url.pathname.startsWith("/api/doc/")) {
      const p = decodeURIComponent(url.pathname.slice("/api/doc/".length));
      const doc = await handleDoc(p);
      if (!doc) return sendJson(res, 404, { error: "not found", path: p });
      return sendJson(res, 200, doc);
    }
    if (url.pathname === "/api/search") {
      const q = url.searchParams.get("q") || "";
      if (!q.trim()) return sendJson(res, 400, { error: "missing ?q=" });
      const mode = url.searchParams.get("mode") || "hybrid";
      const top = Number(url.searchParams.get("top") || 10);
      return sendJson(res, 200, await handleSearch(q, mode, top));
    }
    if (url.pathname === "/api/skillopt/runs") {
      const limit = Number(url.searchParams.get("limit") || 30);
      return sendJson(res, 200, await handleSkillOptRuns(limit));
    }
    if (url.pathname.startsWith("/api/skillopt/run/")) {
      const runId = decodeURIComponent(url.pathname.slice("/api/skillopt/run/".length));
      const info = await handleSkillOptRunSummary(runId);
      if (!info) return sendJson(res, 404, { error: "run not found", runId });
      return sendJson(res, 200, info);
    }
    return sendText(res, 404, "not found");
  } catch (e) {
    return sendJson(res, 500, { error: String(e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[viewer-server] http://${HOST}:${PORT}   REPO_ROOT=${REPO_ROOT}`);
});
