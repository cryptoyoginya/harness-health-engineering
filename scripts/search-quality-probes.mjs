#!/usr/bin/env node
// search-quality-probes.mjs — batch a curated set of search queries to gauge
// whether the KB finds the right skills across all 4 sources / 14 categories.
// Writes 06_outputs/_search-quality-report.md and prints a TL;DR.
//
// NB (метрика): PASS = релевантное в top-3 по OR-логике (expected_category ИЛИ
// provider). Это recall@3, НЕ precision@1 — top-1 не всегда самый релевантный.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, join } from 'node:path';
import {
  createEmbedder,
  QUERY_PREFIX,
  openDb,
  searchVec,
  searchBM25,
  fuseRRF,
  DB_PATH,
  REPO_ROOT,
} from './semantic/lib.mjs';

const PROBES = [
  // ============================================================
  // 01-engineering-productivity (4 probes)
  // ============================================================
  { q: 'build mcp server claude tools',            expect_provider: 'anthropic|fabric|cybos',  expect_cat: 'Engineering productivity' },
  { q: 'prompt caching cost reduction claude api', expect_provider: 'anthropic-cookbooks|cybos', expect_cat: 'Engineering productivity' },
  { q: 'code review skill for pull requests',      expect_provider: 'fabric|cybos',             expect_cat: 'Engineering productivity' },
  { q: 'parallel multi-agent dev workflow worktrees', expect_provider: 'cybos|fabric',          expect_cat: 'Engineering productivity' },

  // ============================================================
  // 02-marketing-content (3 probes)
  // ============================================================
  { q: 'write essay in paul graham style',         expect_provider: 'fabric',                   expect_cat: 'Marketing & content' },
  { q: 'newsletter writing prompts',               expect_provider: 'fabric|cybos',             expect_cat: 'Marketing & content' },
  { q: 'blog post landing page conversion copy',   expect_provider: 'cybos|fabric',             expect_cat: 'Marketing & content' },

  // ============================================================
  // 03-strategy-leadership (3 probes — was 0)
  // ============================================================
  { q: 'competitive positioning swot analysis framework', expect_provider: 'fabric|cybos',      expect_cat: 'Strategy & leadership' },
  { q: 'prepare 7s mckinsey strategy',             expect_provider: 'fabric',                   expect_cat: 'Strategy & leadership' },
  { q: 'analyze business risk decision',           expect_provider: 'fabric|cybos',             expect_cat: 'Strategy & leadership' },

  // ============================================================
  // 04-infrastructure (2 probes — was 0)
  // ============================================================
  { q: 'terraform plan iac infrastructure analysis', expect_provider: 'fabric|cybos',           expect_cat: 'Infrastructure' },
  { q: 'self-installable claude code skill via http server', expect_provider: 'cybos',          expect_cat: 'Infrastructure' },

  // ============================================================
  // 05-sales-outbound (3 probes — was 1)
  // ============================================================
  { q: 'analyze sales call transcript scoring',    expect_provider: 'fabric|cybos',             expect_cat: 'Sales & outbound' },
  { q: 'cold outbound email prospect personalize', expect_provider: 'cybos|fabric',             expect_cat: 'Sales & outbound' },
  { q: 'create hormozi grand slam offer',          expect_provider: 'fabric',                   expect_cat: 'Sales & outbound' },

  // ============================================================
  // 06-operations (3 probes — was 1)
  // ============================================================
  { q: 'meeting summary auto crm slack',           expect_provider: 'cybos|fabric',             expect_cat: 'Operations|Sales & outbound' },
  { q: 'transcribe minutes board meeting',         expect_provider: 'fabric|cybos',             expect_cat: 'Operations' },
  { q: 'agility user story epic agile',            expect_provider: 'fabric|cybos',             expect_cat: 'Operations' },

  // ============================================================
  // 07-knowledge-management (3 probes — was 2)
  // ============================================================
  { q: 'extract wisdom from podcast or video',     expect_provider: 'fabric',                   expect_cat: 'Knowledge management' },
  { q: 'summarize research paper academic',        expect_provider: 'fabric|cybos',             expect_cat: 'Knowledge management' },
  { q: 'extract book ideas highlights reading',    expect_provider: 'fabric',                   expect_cat: 'Knowledge management' },

  // ============================================================
  // 08-hr-hiring (3 probes — was 1)
  // ============================================================
  { q: 'candidate cv resume analysis hire',        expect_provider: 'fabric|cybos',             expect_cat: 'HR & hiring' },
  { q: 'interview question preparation answer',    expect_provider: 'fabric|cybos',             expect_cat: 'HR & hiring' },
  { q: 'analyze personality from text behavior',   expect_provider: 'fabric',                   expect_cat: 'HR & hiring' },

  // ============================================================
  // 09-founder-productivity (3 probes — was 1)
  // ============================================================
  { q: 'tony robbins year in review self reflection', expect_provider: 'fabric|cybos',          expect_cat: 'Founder productivity' },
  { q: 'find blindspots dunning kruger thinking',  expect_provider: 'fabric',                   expect_cat: 'Founder productivity' },
  { q: 'daily focus top priorities founder',       expect_provider: 'cybos|fabric',             expect_cat: 'Founder productivity' },

  // ============================================================
  // 10-customer-success (2 probes — was 0)
  // ============================================================
  { q: 'analyze product feedback users complaints', expect_provider: 'fabric|cybos',            expect_cat: 'Customer success' },
  { q: 'saas churn prevention retention onboarding', expect_provider: 'cybos',                  expect_cat: 'Customer success' },

  // ============================================================
  // 11-data-bi (3 probes — was 1)
  // ============================================================
  { q: 'build dashboard chart with claude',        expect_provider: 'cybos|fabric',             expect_cat: 'Data & BI' },
  { q: 'natural language analytics over warehouse', expect_provider: 'cybos',                   expect_cat: 'Data & BI' },
  { q: 'classification embeddings text categories', expect_provider: 'anthropic-cookbooks',     expect_cat: 'Engineering productivity|Data & BI' },

  // ============================================================
  // 12-design (3 probes — was 2)
  // ============================================================
  { q: 'apply anthropic brand colors typography',  expect_provider: 'anthropic',                expect_cat: 'Design' },
  { q: 'design system tokens for frontend',        expect_provider: 'anthropic|cybos',          expect_cat: 'Design' },
  { q: 'algorithmic art generative design pattern', expect_provider: 'anthropic',               expect_cat: 'Design' },

  // ============================================================
  // 13-cybersecurity (3 probes — was 2)
  // ============================================================
  { q: 'analyze malware threat report',            expect_provider: 'fabric',                   expect_cat: 'Cybersecurity' },
  { q: 'write hackerone bug bounty report',        expect_provider: 'fabric',                   expect_cat: 'Cybersecurity' },
  { q: 'stride threat model security review',      expect_provider: 'fabric',                   expect_cat: 'Cybersecurity' },

  // ============================================================
  // Source-available reference cards (2 probes)
  // ============================================================
  { q: 'create powerpoint deck slides from data',  expect_provider: 'anthropic|cybos',          expect_cat: 'Engineering productivity|Operations' },
  { q: 'extract tables from pdf form fill',        expect_provider: 'anthropic',                expect_cat: 'Engineering productivity' },
  { q: 'edit excel spreadsheet formulas xlsx',     expect_provider: 'anthropic',                expect_cat: 'Engineering productivity' },
  { q: 'word document docx generate report',       expect_provider: 'anthropic',                expect_cat: 'Engineering productivity' },
];

function parseFm(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (km) {
      let v = km[2].trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      fm[km[1]] = v;
    }
  }
  return fm;
}

function fileMeta(filePath) {
  try {
    return parseFm(readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function libraryOf(p) {
  // 06_outputs/<library>/...
  const parts = p.split('/');
  const i = parts.indexOf('06_outputs');
  return i >= 0 && i + 1 < parts.length ? parts[i + 1] : '';
}

if (!existsSync(DB_PATH)) {
  console.error('БД не найдена. Запусти node scripts/semantic/index.mjs');
  process.exit(1);
}

const db = openDb();
const embed = await createEmbedder();

const reportRows = [];
const sumLines = [];

for (const probe of PROBES) {
  const [emb] = await embed([QUERY_PREFIX + probe.q]);
  const vec = searchVec(db, emb, { topK: 50 });
  const bm = searchBM25(db, probe.q, { topK: 50 });
  const fused = fuseRRF(vec, bm, { topK: 10 });

  // unique by file
  const seen = new Set();
  const top = [];
  for (const h of fused) {
    if (h.file.endsWith('/_index.md') || h.file.endsWith('/_categories.md')) continue;
    if (h.file.endsWith('/_skills-index.md')) continue;
    if (h.file.endsWith('/_dedup-report.md')) continue;
    if (h.file.endsWith('/_search-quality-report.md')) continue;
    if (seen.has(h.file)) continue;
    seen.add(h.file);
    const fm = fileMeta(h.file);
    top.push({
      file: relative(REPO_ROOT, h.file),
      library: libraryOf(h.file),
      provider: fm.provider || '',
      id: fm.id || '',
      title: fm.title || '',
      category: fm.category || '',
      heading: h.heading || '',
    });
    if (top.length >= 5) break;
  }

  // Evaluate: is top-3 in expected categories?
  const expectedCatRe = new RegExp(probe.expect_cat.split('|').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const expectedProvRe = new RegExp(probe.expect_provider.split('|').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
  const top3 = top.slice(0, 3);
  const catHit = top3.some((t) => expectedCatRe.test(t.category));
  const provHit = top3.some((t) => expectedProvRe.test(t.provider) || expectedProvRe.test(t.library));
  const verdict = catHit && provHit ? '✅ PASS' : catHit ? '⚠️ cat-OK, provider-miss' : provHit ? '⚠️ provider-OK, cat-miss' : '❌ MISS';
  sumLines.push(`  ${verdict}  «${probe.q}»  top-1: ${top[0]?.id || '-'} ${top[0]?.title?.slice(0, 50) || ''}`);
  reportRows.push({ probe, top, verdict });
}

// --- write markdown
const passCount = reportRows.filter((r) => r.verdict.startsWith('✅')).length;
const warnCount = reportRows.filter((r) => r.verdict.startsWith('⚠️')).length;
const missCount = reportRows.filter((r) => r.verdict.startsWith('❌')).length;

const today = new Date().toISOString().slice(0, 10);
const lines = [
  '---',
  'type: report',
  'title: Skills search — quality probes',
  `ingested: ${today}`,
  'version: v0.1',
  '---',
  '',
  '# Skills search — quality probes',
  '',
  `> Батарея из ${PROBES.length} тестовых запросов через гибридный поиск (vector + BM25 + RRF) ` +
    `по объединённой KB из 4 источников. Для каждого запроса проверяется, попадает ли top-3 ` +
    `в ожидаемую категорию и провайдер.`,
  '',
  `**Итог:** ✅ ${passCount} pass · ⚠️ ${warnCount} partial · ❌ ${missCount} miss из ${PROBES.length}.`,
  '',
  '> **Метрика (честно):** PASS = релевантное в **top-3** по OR-логике (категория ИЛИ провайдер) — ' +
    'это **recall@3**, а не **precision@1**.',
  '',
  '## Probes',
  '',
];
for (const { probe, top, verdict } of reportRows) {
  lines.push(`### ${verdict} — \`${probe.q}\``);
  lines.push('');
  lines.push(`Expected: provider ∈ {${probe.expect_provider}}, category ∈ {${probe.expect_cat}}`);
  lines.push('');
  lines.push('| # | ID | Provider | Category | Title | Heading |');
  lines.push('| - | - | - | - | - | - |');
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const titleShort = (t.title || '').slice(0, 60);
    const headingShort = (t.heading || '').slice(0, 40);
    lines.push(`| ${i + 1} | \`${t.id}\` | ${t.provider || t.library} | ${t.category} | ${titleShort} | ${headingShort} |`);
  }
  lines.push('');
}

writeFileSync(join(REPO_ROOT, '06_outputs', '_search-quality-report.md'), lines.join('\n') + '\n');

console.log('--- summary ---');
for (const l of sumLines) console.log(l);
console.log(`\n✅ ${passCount} pass · ⚠️ ${warnCount} partial · ❌ ${missCount} miss out of ${PROBES.length}`);
console.log('report: 06_outputs/_search-quality-report.md');
