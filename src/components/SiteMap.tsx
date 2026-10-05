import { useRef, useState } from "react";
import { useStore } from "../store";
import type { Position } from "../types";

const W = 560;
const H = 520;

function availColor(a: string) {
  if (a === "available") return "#22c55e";
  if (a === "unavailable") return "#ef4444";
  return "#f59e0b";
}

export function SiteMap() {
  const { doc, role, movePosition, setWind, selectedNodeId, setSelectedNodeId, calcCtx } =
    useStore();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [windDraft, setWindDraft] = useState(doc.wind);

  const toSvg = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const y = ((clientY - rect.top) / rect.height) * H;
    return {
      x: Math.max(20, Math.min(W - 20, Math.round(x))),
      y: Math.max(20, Math.min(H - 20, Math.round(y))),
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const { x, y } = toSvg(e.clientX, e.clientY);
    // 实时移动只更新本地视图，松手才提交（见 pointerup）
    setLivePos(dragging, x, y);
  };

  const [live, setLivePosState] = useState<Record<string, Position>>({});
  const setLivePos = (id: string, x: number, y: number) =>
    setLivePosState((m) => ({ ...m, [id]: { ...(doc.positions.find((p) => p.id === id)!), x, y } }));

  const onPointerUp = () => {
    if (!dragging) return;
    const p = live[dragging];
    const original = doc.positions.find((x) => x.id === dragging)!;
    setDragging(null);
    setLivePosState((m) => {
      const c = { ...m };
      delete c[dragging];
      return c;
    });
    if (p && (p.x !== original.x || p.y !== original.y)) {
      movePosition(dragging, p.x, p.y);
    }
  };

  const positions = doc.positions.map((p) => live[p.id] ?? p);

  // 观众区朝向：风箭头
  const windRad = (windDraft.deg * Math.PI) / 180;
  const windX = 40 + Math.cos(windRad) * 22;
  const windY = 40 + Math.sin(windRad) * 22;

  const lockedPositionIds = new Set(
    doc.nodes
      .filter((n) => doc.approvals[n.segmentId]?.status === "approved")
      .map((n) => n.positionId),
  );

  const applyWind = () => setWind(windDraft);

  return (
    <section className="panel sitemap">
      <div className="panel-head">
        <h2>燃放点位平面图</h2>
        <small>{role === "pointLead" ? "拖拽点位调整 · 下方更新风向" : "点位负责人可拖拽点位"}</small>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="map"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />

        {/* 观众区 */}
        <rect
          x={doc.audience.x - 90}
          y={doc.audience.y - 16}
          width={180}
          height={32}
          rx={6}
          fill="#1e3a8a"
          opacity={0.55}
          stroke="#60a5fa"
        />
        <text x={doc.audience.x} y={doc.audience.y + 5} textAnchor="middle" className="svg-text dim">
          观众区
        </text>

        {/* 安全距离环（以每个节点型号要求显示） */}
        {doc.nodes.map((n) => {
          const p = positions.find((x) => x.id === n.positionId)!;
          const model = doc.models.find((m) => m.id === n.modelId);
          if (!model) return null;
          const selected = n.id === selectedNodeId;
          return (
            <circle
              key={"ring-" + n.id}
              cx={p.x}
              cy={p.y}
              r={model.requiredDistanceM}
              fill="none"
              stroke={availColor(n.avail)}
              strokeOpacity={selected ? 0.75 : 0.18}
              strokeWidth={selected ? 1.6 : 1}
              strokeDasharray="4 4"
            />
          );
        })}

        {/* 发射方位线 */}
        {doc.nodes.map((n) => {
          const p = positions.find((x) => x.id === n.positionId)!;
          const rad = (n.azimuthDeg * Math.PI) / 180;
          const selected = n.id === selectedNodeId;
          return (
            <line
              key={"vec-" + n.id}
              x1={p.x}
              y1={p.y}
              x2={p.x + Math.cos(rad) * 26}
              y2={p.y + Math.sin(rad) * 26}
              stroke={availColor(n.avail)}
              strokeOpacity={selected ? 0.95 : 0.35}
              strokeWidth={selected ? 2.4 : 1.4}
            />
          );
        })}

        {/* 点位 */}
        {positions.map((p) => {
          const nodesHere = doc.nodes.filter((n) => n.positionId === p.id);
          const state = nodesHere.some((n) => n.avail === "unknown")
            ? "unknown"
            : nodesHere.some((n) => n.avail === "unavailable")
              ? "unavailable"
              : "available";
          const locked = lockedPositionIds.has(p.id);
          return (
            <g key={p.id}>
              <circle
                cx={p.x}
                cy={p.y}
                r={15}
                fill={availColor(state)}
                fillOpacity={0.18}
                stroke={availColor(state)}
                strokeWidth={2}
                className={role === "pointLead" && !locked ? "point draggable" : "point"}
                onPointerDown={(e) => {
                  if (role !== "pointLead" || locked) return;
                  (e.target as Element).setPointerCapture?.(e.pointerId);
                  setDragging(p.id);
                }}
              />
              {locked && (
                <text x={p.x + 12} y={p.y - 12} className="svg-lock">
                  🔒
                </text>
              )}
              <text x={p.x} y={p.y + 4} textAnchor="middle" className="svg-text">
                {p.name.split(" ")[0]}
              </text>
              <text x={p.x} y={p.y + 30} textAnchor="middle" className="svg-text dim">
                ({p.x},{p.y})
              </text>
            </g>
          );
        })}

        {/* 风玫瑰 */}
        <g>
          <circle cx={40} cy={40} r={30} fill="#0f172a" stroke="#334155" />
          <line
            x1={40}
            y1={40}
            x2={windX}
            y2={windY}
            stroke="#38bdf8"
            strokeWidth={2.4}
            markerEnd="url(#arrow)"
          />
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#38bdf8" />
            </marker>
          </defs>
          <text x={40} y={86} textAnchor="middle" className="svg-text dim">
            风吹向 {windDraft.deg}° / {windDraft.speedKmh}km/h
          </text>
        </g>
      </svg>

      <div className="wind-row">
        <label>
          风向（吹向，度）
          <input
            type="number"
            min={0}
            max={360}
            value={windDraft.deg}
            disabled={role !== "pointLead"}
            onChange={(e) => setWindDraft((w) => ({ ...w, deg: Number(e.target.value) }))}
          />
        </label>
        <label>
          风速 km/h
          <input
            type="number"
            min={0}
            max={60}
            value={windDraft.speedKmh}
            disabled={role !== "pointLead"}
            onChange={(e) => setWindDraft((w) => ({ ...w, speedKmh: Number(e.target.value) }))}
          />
        </label>
        <button
          className="primary small"
          disabled={
            role !== "pointLead" ||
            (windDraft.deg === doc.wind.deg && windDraft.speedKmh === doc.wind.speedKmh)
          }
          onClick={applyWind}
        >
          更新气象（全场重算）
        </button>
      </div>

      <div className="legend">
        <span><i className="dot ok" /> 可用</span>
        <span><i className="dot bad" /> 不可用</span>
        <span><i className="dot wait" /> 待重算</span>
        <span>🔒 已放行锁定（改点位需先撤销放行）</span>
      </div>
    </section>
  );
}
