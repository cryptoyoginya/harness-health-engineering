// Graph.tsx — визуализация графа связей через Sigma 3 + Graphology + ForceAtlas2.
// Источник данных — /api/graph (читает таблицу links из .semantic-index.sqlite).

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import { api, type GraphResponse } from "@/api";

const LAYER_COLORS: Record<string, string> = {
  "00_context": "#888888",
  "02_sources": "#5b9bd5",
  "03_wiki": "#70ad47",
  "04_synthesis": "#ed7d31",
  "05_decisions": "#c0504d",
  "06_outputs": "#7030a0",
};

export function GraphPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const [data, setData] = useState<GraphResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.graph().then(setData).catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!containerRef.current || !data) return;
    if (data.error || data.hint) return;

    const g = new Graph({ multi: true, allowSelfLoops: false });
    for (const n of data.nodes) {
      g.addNode(n.id, {
        label: n.label,
        size: 4,
        color: LAYER_COLORS[n.layer] ?? "#999",
        layer: n.layer,
        x: Math.random(),
        y: Math.random(),
      });
    }
    for (const e of data.edges) {
      if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
      try {
        g.addEdge(e.source, e.target, { size: 1, color: "#cccccc" });
      } catch { /* duplicate */ }
    }

    forceAtlas2.assign(g, {
      iterations: 200,
      settings: forceAtlas2.inferSettings(g),
    });

    const renderer = new Sigma(g, containerRef.current, {
      labelDensity: 0.07,
      labelRenderedSizeThreshold: 6,
      defaultEdgeColor: "#dddddd",
      renderEdgeLabels: false,
    });
    renderer.on("clickNode", ({ node }) => navigate(`/doc/${node}`));
    sigmaRef.current = renderer;

    return () => {
      renderer.kill();
      sigmaRef.current = null;
    };
  }, [data, navigate]);

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <div className="border-b border-border px-4 py-2 text-sm">
        <span className="font-medium">Граф связей</span>{" "}
        <span className="text-muted-foreground">
          {data && !data.error && !data.hint
            ? `${data.nodes.length} файлов, ${data.edges.length} рёбер · клик по ноде → открыть документ`
            : ""}
        </span>
      </div>

      {err ? <div className="p-4 text-sm text-[var(--color-saldo-neg,#c43)]">{err}</div> : null}
      {data?.hint ? (
        <div className="p-4 text-sm text-muted-foreground">
          {data.hint}. Запустите <code>node scripts/semantic/index.mjs</code>, чтобы построить
          .semantic-index.sqlite (граф читается из таблицы <code>links</code>).
        </div>
      ) : null}
      {data?.error ? <div className="p-4 text-sm">{data.error}</div> : null}

      <div ref={containerRef} className="flex-1 bg-card/30" />

      {data && !data.error && !data.hint ? (
        <div className="border-t border-border px-4 py-2 text-xs">
          <span className="text-muted-foreground">Слои:</span>
          {Object.entries(LAYER_COLORS).map(([layer, color]) => (
            <span key={layer} className="ml-3 inline-flex items-center gap-1">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
              {layer}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
