// api.ts — типизированный клиент API (см. server.ts).

export type DocMeta = {
  path: string;
  layer: string;
  name: string;
  size: number;
  mtime: number;
  title: string | null;
  frontmatter: Record<string, unknown>;
};

export type TreeResponse = {
  layers: string[];
  tree: Record<string, DocMeta[]>;
  builtAt: number;
};

export type DocFull = {
  path: string;
  layer: string;
  raw: string;
  body: string;
  frontmatter: Record<string, unknown>;
  backlinks: string[];
};

export type GraphNode = { id: string; label: string; layer: string };
export type GraphEdge = { source: string; target: string; type: string };
export type GraphResponse = { nodes: GraphNode[]; edges: GraphEdge[]; hint?: string; error?: string };

export type SearchResult = {
  file: string;
  line: number;
  layer: string;
  heading: string;
  similarity: number | null;
  bm25_score: number | null;
  fused: number | null;
  vec_rank: number | null;
  bm25_rank: number | null;
  text: string;
};

export type SearchResponse =
  | { results: SearchResult[]; query: string; mode: string; top: number }
  | { error: string; raw?: string };

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} on ${url}`);
  return (await r.json()) as T;
}

export const api = {
  tree: () => fetchJson<TreeResponse>("/api/tree"),
  doc: (path: string) => fetchJson<DocFull>(`/api/doc/${encodeURI(path)}`),
  graph: () => fetchJson<GraphResponse>("/api/graph"),
  search: (q: string, mode: "hybrid" | "vector" | "bm25" = "hybrid", top = 10) =>
    fetchJson<SearchResponse>(
      `/api/search?q=${encodeURIComponent(q)}&mode=${mode}&top=${top}`,
    ),
};
