import GithubSlugger from "github-slugger";

export type TocItem = { level: 2 | 3; title: string; slug: string };

export function extractToc(source: string): TocItem[] {
  const slugger = new GithubSlugger();
  const items: TocItem[] = [];
  const lines = source.split("\n");
  let inCodeBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (/^```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const m3 = line.match(/^###\s+(.+?)\s*#*\s*$/);
    if (m3) {
      const title = stripInline(m3[1]);
      items.push({ level: 3, title, slug: slugger.slug(title) });
      continue;
    }
    const m2 = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (m2) {
      const title = stripInline(m2[1]);
      items.push({ level: 2, title, slug: slugger.slug(title) });
    }
  }
  return items;
}

function stripInline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}
