#!/usr/bin/env node
// mcp-server.mjs — MCP-сервер (stdio), экспонирующий поиск/синтез/backlinks
// поверх локального semantic-индекса KB.
//
// Запуск (вручную для проверки):
//   node scripts/semantic/mcp-server.mjs
//
// Подключение в Claude Desktop / Claude Code:
//   Добавить в ~/.claude/mcp.json или .mcp.json проекта:
//     {
//       "mcpServers": {
//         "kb-local": {
//           "command": "node",
//           "args": ["/absolute/path/to/scripts/semantic/mcp-server.mjs"]
//         }
//       }
//     }
//
// Экспортируемые tools:
//   • kb_search    — гибридный поиск (vector + BM25 + RRF), JSON-результат
//   • kb_think     — собрать промпт-синтез по правилам AGENTS.md
//   • kb_backlinks — кто ссылается на файл (по frontmatter related:)
//
// Реализация переиспользует ./lib.mjs — никакой дубликации логики.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  createEmbedder,
  QUERY_PREFIX,
  openDb,
  searchVec,
  searchBM25,
  fuseRRF,
  getBacklinks,
  getForwardLinks,
  DB_PATH,
  REPO_ROOT,
  INDEXABLE_LAYERS,
} from './lib.mjs';

if (!existsSync(DB_PATH)) {
  console.error(`[mcp-kb] БД не найдена: ${DB_PATH}. Запустите: node scripts/semantic/index.mjs`);
  process.exit(1);
}

// Имя сервера — basename корня репо. Замените на своё, если хочется.
const SERVER_NAME = `kb-${basename(REPO_ROOT)}`;

// Singletons. БД открывается лениво при первом вызове (sqlite-vec при загрузке требует pwd).
let _db = null;
function db() {
  if (!_db) _db = openDb();
  return _db;
}
let _embedder = null;
async function embedder() {
  if (!_embedder) _embedder = await createEmbedder();
  return _embedder;
}

// Если в корне репо есть AGENTS.md — он становится системным промптом для kb_think.
function loadSystemPrompt() {
  try {
    const text = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
    if (text.trim()) return text;
  } catch { /* fallthrough */ }
  return [
    'Ты помогаешь по KB этого проекта. Отвечай на русском.',
    'Каждое нетривиальное утверждение помечай меткой FACT/INFERENCE/ASSUMPTION/UNKNOWN/RISK/DECISION/RECOMMENDATION',
    'и сопровождай цитатой [source: /path]. Если evidence не хватает — отвечай UNKNOWN, не выдумывай.',
  ].join('\n');
}

const server = new McpServer({
  name: SERVER_NAME,
  version: '0.1.0',
});

// ---------- kb_search ----------

server.registerTool(
  'kb_search',
  {
    description:
      'Hybrid search в локальной KB (vector e5-small + BM25 FTS5 + RRF). ' +
      'Возвращает топ-K чанков с file, line, layer, heading, snippet и score. ' +
      'Используй ДО ответа пользователю по любому вопросу о содержимом KB. ' +
      'Без поиска сначала — ответы будут галлюцинировать.',
    inputSchema: {
      query: z.string().min(1).describe('Поисковый запрос на русском или английском.'),
      mode: z
        .enum(['hybrid', 'vector', 'bm25'])
        .optional()
        .describe('Канал поиска. По умолчанию hybrid (RRF над vector и BM25).'),
      top: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe('Сколько результатов вернуть (default 10).'),
      layer: z
        .enum(INDEXABLE_LAYERS)
        .optional()
        .describe('Фильтр по слою KB. Опционально.'),
    },
  },
  async ({ query, mode = 'hybrid', top = 10, layer = null }) => {
    let results;
    if (mode === 'bm25') {
      results = searchBM25(db(), query, { topK: top, layer }).map((r) => ({
        ...r,
        _channel: 'bm25',
      }));
    } else if (mode === 'vector') {
      const embed = await embedder();
      const [qe] = await embed([QUERY_PREFIX + query]);
      results = searchVec(db(), qe, { topK: top, layer }).map((r) => ({
        ...r,
        _channel: 'vector',
      }));
    } else {
      const overK = Math.max(top * 3, 20);
      const embed = await embedder();
      const [qe] = await embed([QUERY_PREFIX + query]);
      const vecResults = searchVec(db(), qe, { topK: overK, layer });
      const bmResults = searchBM25(db(), query, { topK: overK, layer });
      results = fuseRRF(vecResults, bmResults, { topK: top });
    }

    const out = results.map((r, i) => ({
      rank: i + 1,
      file: r.file,
      line: r.line_start,
      layer: r.layer,
      heading: r.heading,
      similarity: r.similarity != null ? Number(r.similarity.toFixed(4)) : null,
      bm25_score: r.score != null ? Number(r.score.toFixed(4)) : (r.bm25_score != null ? Number(r.bm25_score.toFixed(4)) : null),
      fused: r.fused != null ? Number(r.fused.toFixed(6)) : null,
      vec_rank: r.vec_rank ?? null,
      bm25_rank: r.bm25_rank ?? null,
      snippet: r.text.length > 400 ? r.text.slice(0, 400) + '…' : r.text,
    }));

    return {
      content: [
        { type: 'text', text: `Найдено ${out.length} чанков (mode=${mode}${layer ? `, layer=${layer}` : ''}):` },
        { type: 'text', text: JSON.stringify(out, null, 2) },
      ],
    };
  },
);

// ---------- kb_think ----------

server.registerTool(
  'kb_think',
  {
    description:
      'Собрать структурированный промпт-контекст под вопрос по KB. ' +
      'Возвращает системную инструкцию (метки FACT/INFERENCE/UNKNOWN/RISK/DECISION по AGENTS.md), ' +
      'топ-K релевантных чанков с цитатами и возрастом, gap-сигналы (stale evidence). ' +
      'Используй когда нужен синтез, а не просто список ссылок.',
    inputSchema: {
      question: z.string().min(1).describe('Вопрос пользователя на русском или английском.'),
      top: z
        .number()
        .int()
        .positive()
        .max(30)
        .optional()
        .describe('Сколько чанков включить в контекст (default 12).'),
      layer: z
        .enum(INDEXABLE_LAYERS)
        .optional()
        .describe('Фильтр по слою KB.'),
    },
  },
  async ({ question, top = 12, layer = null }) => {
    const overK = Math.max(top * 3, 30);
    const embed = await embedder();
    const [qe] = await embed([QUERY_PREFIX + question]);
    const vecResults = searchVec(db(), qe, { topK: overK, layer });
    const bmResults = searchBM25(db(), question, { topK: overK, layer });
    const fused = fuseRRF(vecResults, bmResults, { topK: top });

    const uniqueFiles = Array.from(new Set(fused.map((r) => r.file)));
    const now = Date.now();
    const STALE_DAYS = 90;
    const fileMeta = new Map();
    let allStale = uniqueFiles.length > 0;
    for (const f of uniqueFiles) {
      let mtimeMs = 0;
      try { mtimeMs = statSync(join(REPO_ROOT, f)).mtimeMs; } catch { mtimeMs = 0; }
      const ageDays = mtimeMs ? Math.floor((now - mtimeMs) / 86_400_000) : null;
      if (ageDays !== null && ageDays < STALE_DAYS) allStale = false;
      fileMeta.set(f, { mtimeMs, ageDays });
    }

    const lines = [];
    lines.push('# Системная инструкция (источник: AGENTS.md, при наличии)');
    lines.push('');
    lines.push(loadSystemPrompt());
    lines.push('');
    if (allStale) {
      lines.push(`> ⚠️ Все источники старше ${STALE_DAYS} дней — пометь RISK: stale evidence.`);
      lines.push('');
    }
    lines.push(`# Вопрос\n${question}\n`);
    lines.push('# Контекст (топ чанков, hybrid retrieval)');
    for (let i = 0; i < fused.length; i++) {
      const c = fused[i];
      const meta = fileMeta.get(c.file);
      const age = meta?.ageDays != null ? `${meta.ageDays}д` : '?';
      lines.push(`\n## [${i + 1}] /${c.file}:${c.line_start}  layer=${c.layer}  heading=«${c.heading || '—'}»  age=${age}\n`);
      lines.push(c.text);
    }
    lines.push('\n# Используй ровно эти пути в [source: ...]:');
    for (const f of uniqueFiles) lines.push(`- /${f}`);

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

// ---------- kb_backlinks ----------

server.registerTool(
  'kb_backlinks',
  {
    description:
      'Кто ссылается на файл (по frontmatter related:). ' +
      'Полезно ПЕРЕД редактированием wiki/synthesis: видишь blast radius. ' +
      'С forward=true — наоборот, на что ссылается сам файл.',
    inputSchema: {
      path: z.string().min(1).describe('Относительный путь к файлу, например 05_decisions/some-decision.md'),
      forward: z.boolean().optional().describe('Если true — forward links (этот → ...). Default false (backlinks).'),
    },
  },
  async ({ path, forward = false }) => {
    const rows = forward ? getForwardLinks(db(), path) : getBacklinks(db(), path);
    const direction = forward ? 'forward (этот файл → ...)' : 'backlinks (... → этот файл)';
    if (rows.length === 0) {
      return { content: [{ type: 'text', text: `${path}  ${direction}\n(связей не найдено)` }] };
    }
    const out = rows.map((r) => ({ file: forward ? r.dst : r.src, type: r.type }));
    return {
      content: [
        { type: 'text', text: `${path}  ${direction}` },
        { type: 'text', text: JSON.stringify(out, null, 2) },
      ],
    };
  },
);

// ---------- start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
// Лог уходит в stderr — stdout зарезервирован под JSON-RPC.
console.error('[mcp-kb] started, awaiting requests on stdio');
