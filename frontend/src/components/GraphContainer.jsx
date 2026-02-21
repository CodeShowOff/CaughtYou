import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import FA2Layout from "graphology-layout-forceatlas2/worker";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { circular } from "graphology-layout";

const PATTERN_COLORS = {
  cycle: "#22c55e",
  fan_in: "#f59e0b",
  fan_out: "#a855f7",
  shell_chain: "#06b6d4",
  mule_chain: "#06b6d4",
  multiple: "#f43f5e",
};

const SUSPICIOUS_COLOR = "#ef4444";
const DEFAULT_COLOR = "#60a5fa";
const EDGE_COLOR = "#c8d3e0";
const HIGHLIGHT_EDGE_COLOR = "#3b82f6";

function buildNodeMeta(graphData) {
  const meta = new Map();
  const typeSets = new Map();

  for (const ring of graphData.fraud_rings) {
    const pType = ring.pattern_type || "cycle";
    for (const acc of ring.member_accounts) {
      if (!typeSets.has(acc)) typeSets.set(acc, new Set());
      typeSets.get(acc).add(pType);
    }
  }

  for (const [acc, types] of typeSets) {
    meta.set(acc, { patternType: types.size > 1 ? "multiple" : [...types][0] });
  }

  for (const sa of graphData.suspicious_accounts) {
    const existing = meta.get(sa.account_id) || {};
    meta.set(sa.account_id, {
      ...existing,
      isSuspicious: true,
      score: sa.suspicion_score,
      patterns: sa.detected_patterns,
    });
  }

  return meta;
}

function getNodeColor(meta) {
  if (!meta) return DEFAULT_COLOR;
  if (meta.patternType && PATTERN_COLORS[meta.patternType]) {
    return PATTERN_COLORS[meta.patternType];
  }
  if (meta.isSuspicious) return SUSPICIOUS_COLOR;
  return DEFAULT_COLOR;
}

function getNodeSize(meta, isLarge) {
  const base = isLarge ? 3 : 5;
  if (!meta) return base;
  if (meta.isSuspicious) return base * 2.5;
  if (meta.patternType) return base * 1.5;
  return base;
}

function createGraph(graphData, nodeMeta) {
  const graph = new Graph({ multi: false, type: "directed" });

  const nodeCount = graphData.nodes.length;
  const isLarge = nodeCount > 500;

  for (const nodeId of graphData.nodes) {
    const m = nodeMeta.get(nodeId);
    graph.addNode(nodeId, {
      label: nodeId,
      size: getNodeSize(m, isLarge),
      color: getNodeColor(m),
      isSuspicious: m?.isSuspicious || false,
      score: m?.score ?? null,
      patterns: m?.patterns ?? [],
      patternType: m?.patternType ?? "none",
      originalColor: getNodeColor(m),
      originalSize: getNodeSize(m, isLarge),
    });
  }

  for (const edge of graphData.edges) {
    const key = `${edge.sender_id}_${edge.receiver_id}`;
    if (
      graph.hasNode(edge.sender_id) &&
      graph.hasNode(edge.receiver_id) &&
      !graph.hasEdge(key)
    ) {
      graph.addEdgeWithKey(key, edge.sender_id, edge.receiver_id, {
        size: isLarge ? 0.3 : 0.8,
        color: EDGE_COLOR,
        type: "arrow",
      });
    }
  }

  circular.assign(graph);

  return graph;
}

const RING_HIGHLIGHT_COLOR = "#f97316";

function GraphContainer({ graphData, rawGraphData, onNodeSelect, activeFilter, onFilterChange, availableFilters, filterLabels, highlightedRing, onRingClear }) {
  const sigmaRef = useRef(null);
  const graphRef = useRef(null);
  const containerRef = useRef(null);
  const fa2Ref = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [isRendering, setIsRendering] = useState(false);
  const [isLayouting, setIsLayouting] = useState(false);
  const onNodeSelectRef = useRef(onNodeSelect);
  const hoveredNodeRef = useRef(null);
  const selectedNodeRef = useRef(null);
  const onRingClearRef = useRef(onRingClear);
  const highlightedRingMembersRef = useRef(null);

  useEffect(() => {
    onNodeSelectRef.current = onNodeSelect;
  }, [onNodeSelect]);

  useEffect(() => {
    onRingClearRef.current = onRingClear;
  }, [onRingClear]);

  useEffect(() => {
    highlightedRingMembersRef.current = highlightedRing
      ? new Set(highlightedRing.member_accounts)
      : null;
    if (sigmaRef.current) sigmaRef.current.refresh();
  }, [highlightedRing]);

  const nodeMeta = useMemo(
    () => (graphData ? buildNodeMeta(graphData) : new Map()),
    [graphData],
  );

  const nodeCount = graphData?.nodes?.length ?? 0;
  const edgeCount = graphData?.edges?.length ?? 0;

  useEffect(() => {
    if (
      !containerRef.current ||
      !graphData ||
      !graphData.nodes ||
      graphData.nodes.length === 0
    )
      return;

    if (sigmaRef.current) {
      sigmaRef.current.kill();
      sigmaRef.current = null;
    }
    graphRef.current = null;
    hoveredNodeRef.current = null;
    selectedNodeRef.current = null;

    setIsRendering(true);
    setTooltip(null);

    const rafId = requestAnimationFrame(() => {
      const timerId = setTimeout(() => {
        try {
          const graph = createGraph(graphData, nodeMeta);
          graphRef.current = graph;

          const n = graphData.nodes.length;
          const isLarge = n > 500;
          const isHuge = n > 3000;

          const sigma = new Sigma(graph, containerRef.current, {
            renderLabels: !isHuge,
            renderEdgeLabels: false,
            labelRenderedSizeThreshold: isHuge ? 999 : isLarge ? 14 : 6,
            labelDensity: isLarge ? 0.03 : 0.1,
            labelGridCellSize: isLarge ? 250 : 100,
            defaultEdgeType: "arrow",
            hideEdgesOnMove: isHuge,
            hideLabelsOnMove: isLarge,
            allowInvalidContainer: true,
            minCameraRatio: 0.01,
            maxCameraRatio: 20,

            nodeReducer(node, data) {
              const res = { ...data };
              const hovered = hoveredNodeRef.current;
              const selected = selectedNodeRef.current;
              const ringMembers = highlightedRingMembersRef.current;

              if (ringMembers && !hovered) {
                if (ringMembers.has(node)) {
                  res.highlighted = true;
                  res.zIndex = 2;
                  res.color = RING_HIGHLIGHT_COLOR;
                  res.size = (res.originalSize || res.size) * 1.6;
                } else {
                  res.color = "#e2e8f0";
                  res.label = "";
                  res.zIndex = 0;
                }
                return res;
              }

              if (selected && node === selected) {
                res.highlighted = true;
                res.zIndex = 2;
              }

              if (hovered) {
                if (node === hovered) {
                  res.highlighted = true;
                  res.zIndex = 2;
                } else if (!isHuge) {
                  const g = graphRef.current;
                  if (
                    g &&
                    (g.hasEdge(hovered, node) || g.hasEdge(node, hovered))
                  ) {
                  } else {
                    res.color = "#e2e8f0";
                    res.label = "";
                  }
                }
              }

              return res;
            },

            edgeReducer(edge, data) {
              const res = { ...data };
              const hovered = hoveredNodeRef.current;
              const ringMembers = highlightedRingMembersRef.current;

              if (ringMembers && !hovered) {
                const g = graphRef.current;
                if (g) {
                  const src = g.source(edge);
                  const tgt = g.target(edge);
                  if (ringMembers.has(src) && ringMembers.has(tgt)) {
                    res.color = RING_HIGHLIGHT_COLOR;
                    res.size = 2;
                  } else {
                    res.hidden = true;
                  }
                }
                return res;
              }

              if (hovered && !isHuge) {
                const g = graphRef.current;
                if (g) {
                  const src = g.source(edge);
                  const tgt = g.target(edge);
                  if (src !== hovered && tgt !== hovered) {
                    res.hidden = true;
                  } else {
                    res.color = HIGHLIGHT_EDGE_COLOR;
                    res.size = 2;
                  }
                }
              }

              return res;
            },
          });

          sigma.on("enterNode", ({ node }) => {
            hoveredNodeRef.current = node;
            const attrs = graph.getNodeAttributes(node);
            const viewportPos = sigma.graphToViewport(
              graph.getNodeAttributes(node),
            );
            setTooltip({
              x: viewportPos.x,
              y: viewportPos.y,
              id: node,
              score: attrs.score,
              patterns: attrs.patterns,
              isSuspicious: attrs.isSuspicious,
              patternType: attrs.patternType,
            });
            sigma.refresh();
          });

          sigma.on("leaveNode", () => {
            hoveredNodeRef.current = null;
            setTooltip(null);
            sigma.refresh();
          });

          sigma.on("clickNode", ({ node }) => {
            selectedNodeRef.current = node;
            const attrs = graph.getNodeAttributes(node);
            if (onNodeSelectRef.current) {
              onNodeSelectRef.current({
                id: node,
                isSuspicious: attrs.isSuspicious,
                score: attrs.score,
                patterns: attrs.patterns,
              });
            }
            sigma.refresh();
          });

          sigma.on("clickStage", () => {
            selectedNodeRef.current = null;
            if (onNodeSelectRef.current) {
              onNodeSelectRef.current(null);
            }
            if (onRingClearRef.current) {
              onRingClearRef.current();
            }
            sigma.refresh();
          });

          sigmaRef.current = sigma;
          setIsRendering(false);

          const fa2Settings = forceAtlas2.inferSettings(graph);
          const fa2 = new FA2Layout(graph, {
            settings: {
              ...fa2Settings,
              barnesHutOptimize: n > 300,
              gravity: n > 3000 ? 5 : 1,
              scalingRatio: n > 3000 ? 20 : 10,
              slowDown: 5,
            },
          });

          fa2Ref.current = fa2;
          fa2.start();
          setIsLayouting(true);

          const layoutDuration = n > 5000 ? 8000 : n > 2000 ? 6000 : 4000;
          const stopTimer = setTimeout(() => {
            if (fa2Ref.current === fa2 && fa2.isRunning()) {
              fa2.stop();
              setIsLayouting(false);
            }
          }, layoutDuration);
          containerRef.current.__stopTimer = stopTimer;

        } catch (err) {
          console.error("Sigma render error:", err);
          setIsRendering(false);
        }
      }, 50);

      containerRef.current.__timerId = timerId;
    });

    return () => {
      cancelAnimationFrame(rafId);
      if (containerRef.current?.__timerId) {
        clearTimeout(containerRef.current.__timerId);
      }
      if (containerRef.current?.__stopTimer) {
        clearTimeout(containerRef.current.__stopTimer);
      }
      if (fa2Ref.current) {
        if (fa2Ref.current.isRunning()) fa2Ref.current.stop();
        fa2Ref.current.kill();
        fa2Ref.current = null;
      }
      if (sigmaRef.current) {
        sigmaRef.current.kill();
        sigmaRef.current = null;
      }
      graphRef.current = null;
    };
  }, [graphData, nodeMeta]);

  const handleFit = useCallback(() => {
    if (sigmaRef.current) {
      const camera = sigmaRef.current.getCamera();
      camera.animatedReset({ duration: 300 });
    }
  }, []);

  const handleToggleLayout = useCallback(() => {
    const fa2 = fa2Ref.current;
    if (!fa2) return;
    if (onRingClearRef.current) onRingClearRef.current();
    if (fa2.isRunning()) {
      fa2.stop();
      setIsLayouting(false);
    } else {
      fa2.start();
      setIsLayouting(true);
      setTimeout(() => {
        if (fa2Ref.current === fa2 && fa2.isRunning()) {
          fa2.stop();
          setIsLayouting(false);
        }
      }, 5000);
    }
  }, []);

  const hasData = graphData && graphData.nodes && graphData.nodes.length > 0;
  const graphHeight = 600;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 w-full">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold text-slate-800">Network Graph</h2>

        {graphData && (
          <div className="flex items-center gap-2">
            {hasData && (
              <span className="text-xs text-slate-500">
                {nodeCount.toLocaleString()} nodes &middot;{" "}
                {edgeCount.toLocaleString()} edges
                {graphData.fraud_rings && (
                  <>
                    {" "}
                    &middot;{" "}
                    {graphData.fraud_rings.length.toLocaleString()} rings
                  </>
                )}
              </span>
            )}

            {hasData && !isRendering && (
              <button
                onClick={handleToggleLayout}
                className={`ml-1 px-2.5 py-1 text-xs rounded-md font-medium transition-colors ${
                  isLayouting
                    ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                    : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
                title={isLayouting ? "Stop layout computation" : "Restart layout computation"}
              >
                {isLayouting ? (
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                    Layouting…
                  </span>
                ) : (
                  "Re-layout"
                )}
              </button>
            )}

            {hasData && !isRendering && (
              <button
                onClick={handleFit}
                className="ml-1 p-1.5 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-100 transition-colors"
                title="Fit graph to view"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M3 4a1 1 0 011-1h4a1 1 0 010 2H5v3a1 1 0 01-2 0V4zM16 3a1 1 0 011 1v3a1 1 0 11-2 0V5h-3a1 1 0 110-2h4zM4 13a1 1 0 011 1v2h3a1 1 0 110 2H4a1 1 0 01-1-1v-4a1 1 0 011 0zM17 13a1 1 0 01-1 1v2h-3a1 1 0 110 2h4a1 1 0 001-1v-4a1 1 0 01-1 0z" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {rawGraphData && availableFilters && availableFilters.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-4">
          {availableFilters.map((f) => {
            const isActive = activeFilter === f;
            return (
              <button
                key={f}
                onClick={() => onFilterChange(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                  isActive
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {filterLabels?.[f] || f}
                {f !== 'all' && rawGraphData?.fraud_rings && (
                  <span className={`ml-1.5 ${isActive ? 'text-blue-200' : 'text-slate-400'}`}>
                    {f === 'suspicious'
                      ? rawGraphData.suspicious_accounts?.length || 0
                      : rawGraphData.fraud_rings.filter((r) => r.pattern_type === f).length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="relative">
        {!hasData && !isRendering && (
          <div
            className="w-full bg-slate-50 rounded-lg border border-dashed border-slate-300 flex items-center justify-center"
            style={{ height: `${graphHeight}px` }}
          >
            <div className="text-center text-slate-400">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-16 w-16 mx-auto mb-3 text-slate-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
              <p className="text-sm font-medium">No graph data yet</p>
              <p className="text-xs mt-1">
                Upload a CSV file to visualize the transaction network
              </p>
            </div>
          </div>
        )}

        <div
          ref={containerRef}
          id="sigma-container"
          className="w-full bg-slate-50 rounded-lg border border-slate-200"
          style={{
            height: `${graphHeight}px`,
            display: !hasData && !isRendering ? "none" : "block",
          }}
        />

        {isRendering && (
          <div className="absolute inset-0 bg-slate-50/80 backdrop-blur-sm rounded-lg flex items-center justify-center z-20">
            <div className="flex flex-col items-center gap-3">
              <div className="relative">
                <div className="w-10 h-10 border-4 border-slate-200 rounded-full" />
                <div className="absolute inset-0 w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-slate-700">
                  Building graph…
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {nodeCount > 0
                    ? `${nodeCount.toLocaleString()} nodes — WebGL rendering`
                    : "Processing"}
                </p>
              </div>
            </div>
          </div>
        )}

        {tooltip && (
          <div
            className="absolute pointer-events-none bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg z-10"
            style={{
              left: tooltip.x + 12,
              top: tooltip.y - 10,
              maxWidth: 240,
            }}
          >
            <p className="font-semibold">{tooltip.id}</p>
            {tooltip.patternType && tooltip.patternType !== "none" && (
              <p className="text-gray-400 capitalize">
                {tooltip.patternType.replace(/_/g, " ")}
              </p>
            )}
            {tooltip.isSuspicious && (
              <>
                <p className="text-red-300">Score: {tooltip.score}</p>
                <p className="text-gray-300 truncate">
                  {tooltip.patterns?.join(", ")}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {graphData && (
        <div className="mt-4 flex flex-wrap gap-4 text-xs text-slate-600">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-full bg-[#60a5fa]" />
            Normal
          </span>
          {graphData.fraud_rings && graphData.fraud_rings.length > 0 && (
            <>
              {Object.entries(PATTERN_COLORS).map(([type, color]) => {
                if (type === "multiple") {
                  const hasMulti = [...nodeMeta.values()].some(
                    (m) => m.patternType === "multiple",
                  );
                  if (!hasMulti) return null;
                } else {
                  const hasType = graphData.fraud_rings.some(
                    (r) => r.pattern_type === type,
                  );
                  if (!hasType) return null;
                }
                const label = type
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (c) => c.toUpperCase());
                return (
                  <span key={type} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-3 h-3 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {label}
                  </span>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default GraphContainer;
