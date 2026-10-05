import { useRef, useState } from "react";
import type { Category, DocState, IgnitionNode, NodeStatus } from "./types";
import {
  AUDIENCE_TOP,
  MAP_METERS,
  formatTime,
  modelOf,
  nodeLabel,
  pointOf,
  segmentOf,
  windVector,
} from "./logic";
import { store, useStore } from "./store";

/* ---------------- 状态徽章 ---------------- */

const STATUS_TEXT: Record<NodeStatus, string> = {
  available: "可用",
  stale: "待重算",
  recomputing: "重算中",
  blocked: "受限",
};

export function StatusBadge({ status }: { status: NodeStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_TEXT[status]}</span>;
}

/* ---------------- 点位平面图 ---------------- */

export function MapView({
  doc,
  selectedNodeId,
  onSelectNode,
}: {
  doc: DocState;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<string | null>(null);
  const wv = windVector(doc.wind);

  const toSvgCoords = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)),
      y: Math.min(100, Math.max(0, ((clientY - rect.top) / rect.height) * 100)),
    };
  };

  return (
    <div className="map-wrap">
      <svg
        ref={svgRef}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          const { x, y } = toSvgCoords(e.clientX, e.clientY);
          store.movePoint(dragRef.current, x, y);
        }}
        onPointerUp={() => (dragRef.current = null)}
        onPointerLeave={() => (dragRef.current = null)}
      >
        {/* 场地 */}
        <rect x="0" y="0" width="100" height="100" fill="#f8fafc" />
        {/* 距离环（每 20m） */}
        {[20, 40, 60, 80].map((m) => {
          const r = (m / MAP_METERS) * 100;
          return (
            <ellipse
              key={m}
              cx="50"
              cy={AUDIENCE_TOP}
              rx={r}
              ry={r * 0.5}
              fill="none"
              stroke="#e2e8f0"
              strokeWidth="0.4"
            />
          );
        })}
        {/* 观众区 */}
        <rect x="0" y={AUDIENCE_TOP} width="100" height={100 - AUDIENCE_TOP} fill="#fee2e2" />
        <text x="2" y="96" fontSize="4" fill="#b91c1c">
          观众区
        </text>
        {/* 风向箭头 */}
        <g transform="translate(12,12)">
          <line x1="0" y1="0" x2={wv.x * 9} y2={wv.y * 9} stroke="#1d4ed8" strokeWidth="1.2" />
          <circle cx="0" cy="0" r="1.6" fill="#1d4ed8" />
          <text x="0" y={-3} fontSize="3.4" fill="#1d4ed8" textAnchor="middle">
            风向{doc.wind}
          </text>
        </g>
        {/* 点位 */}
        {doc.points.map((p) => {
          const nodesHere = doc.nodes.filter((n) => n.pointId === p.id);
          const hasBlocked = nodesHere.some((n) => n.status === "blocked");
          const hasStale = nodesHere.some((n) => n.status === "stale" || n.status === "recomputing");
          return (
            <g key={p.id}>
              <circle
                cx={p.x}
                cy={p.y}
                r="3.2"
                fill={hasBlocked ? "#dc2626" : hasStale ? "#f59e0b" : "#1d4ed8"}
                stroke="#fff"
                strokeWidth="0.8"
                style={{ cursor: "grab", touchAction: "none" }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  (e.target as Element).setPointerCapture(e.pointerId);
                  dragRef.current = p.id;
                }}
              />
              <text x={p.x} y={p.y - 4.6} fontSize="3.6" fill="#334155" textAnchor="middle">
                {p.name}
              </text>
              <text x={p.x} y={p.y + 7.4} fontSize="2.8" fill="#94a3b8" textAnchor="middle">
                {nodesHere.length}节点
              </text>
            </g>
          );
        })}
        {/* 节点（可点击选中） */}
        {doc.nodes.map((n) => {
          const p = pointOf(doc, n);
          if (!p) return null;
          const selected = n.id === selectedNodeId;
          return (
            <g
              key={n.id}
              onClick={() => onSelectNode(n.id)}
              style={{ cursor: "pointer" }}
            >
              <circle
                cx={p.x + 2.6}
                cy={p.y - 2.6}
                r={selected ? 2.4 : 1.8}
                fill={n.status === "blocked" ? "#dc2626" : n.status === "available" ? "#16a34a" : "#f59e0b"}
                stroke="#fff"
                strokeWidth="0.5"
              />
            </g>
          );
        })}
      </svg>
      <p className="map-hint">拖拽圆点可移动点位；点击节点圆点选中编辑。观众区位于场地下方，风向决定下风向安全距离。</p>
    </div>
  );
}

/* ---------------- 时间轴 ---------------- */

export function Timeline({
  doc,
  selectedNodeId,
  onSelectNode,
}: {
  doc: DocState;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}) {
  const total = Math.max(
    300,
    ...doc.nodes.map((n) => n.fireTime + n.duration + 10),
  );
  return (
    <div className="timeline">
      <div className="tl-axis">
        <span>00:00.000</span>
        <span>{formatTime(total / 2)}</span>
        <span>{formatTime(total)}</span>
      </div>
      {doc.segments.map((seg) => {
        const nodes = doc.nodes
          .filter((n) => n.segmentId === seg.id)
          .sort((a, b) => a.fireTime - b.fireTime);
        return (
          <div className="tl-row" key={seg.id}>
            <div className="tl-lane-label">
              <strong>{seg.name}</strong>
              {seg.approved && <span className="badge badge-approved">已放行</span>}
            </div>
            <div className="tl-track">
              {nodes.map((n) => {
                const selected = n.id === selectedNodeId;
                return (
                  <button
                    key={n.id}
                    className={`tl-node tl-${n.status} ${selected ? "selected" : ""}`}
                    style={{ left: `${(n.fireTime / total) * 100}%` }}
                    onClick={() => onSelectNode(n.id)}
                    title={`${nodeLabel(doc, n)} · ${formatTime(n.fireTime)}`}
                  >
                    <span className="tl-dot" />
                    {formatTime(n.fireTime)}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- 节点绑定编辑 ---------------- */

export function NodeEditor({ doc, nodeId }: { doc: DocState; nodeId: string | null }) {
  const node = doc.nodes.find((n) => n.id === nodeId) ?? null;
  if (!node) {
    return (
      <div className="panel editor-empty">
        <p>在时间轴或平面图中选择一个点火节点，绑定型号、发射角度与点位。</p>
      </div>
    );
  }
  const seg = segmentOf(doc, node);
  const model = modelOf(doc, node);
  const locked = !!seg?.approved;

  const set = (patch: Partial<IgnitionNode>) => store.editNode(node.id, patch);

  return (
    <div className="panel node-editor">
      <div className="heading">
        <div>
          <p>{seg?.name} · 点火节点</p>
          <h3>节点绑定</h3>
        </div>
        <StatusBadge status={node.status} />
      </div>

      {locked && (
        <div className="inline-lock">
          段落《{seg?.name}》已经安全员放行锁定。修改绑定前请先撤销放行。
        </div>
      )}

      <div className="field-grid">
        <label>
          <span>绑定点位</span>
          <select
            value={node.pointId}
            disabled={locked}
            onChange={(e) => set({ pointId: e.target.value })}
          >
            {doc.points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>烟花型号</span>
          <select
            value={node.modelId}
            disabled={locked}
            onChange={(e) => set({ modelId: e.target.value })}
          >
            {doc.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>发射角度（方位角 °）</span>
          <input
            type="number"
            min={0}
            max={360}
            value={node.angle}
            disabled={locked}
            onChange={(e) => set({ angle: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>点火时间（s）</span>
          <input
            type="number"
            min={0}
            step={0.1}
            value={node.fireTime}
            onChange={(e) => set({ fireTime: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>持续时间（s）</span>
          <input
            type="number"
            min={1}
            step={1}
            value={node.duration}
            onChange={(e) => set({ duration: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="node-facts">
        <div><small>口径</small><strong>{model?.caliber ?? "-"} mm</strong></div>
        <div><small>基础安全距离</small><strong>{model?.safetyDistance ?? "-"} m</strong></div>
        <div>
          <small>重算有效安全距离</small>
          <strong>{node.status === "stale" || node.status === "recomputing" ? "—" : `${node.effectiveSafety} m`}</strong>
        </div>
      </div>

      {node.status === "blocked" && (
        <div className="inline-blocked">受限原因：{node.blockedReason}</div>
      )}
      {node.status === "stale" && (
        <div className="inline-stale">点位或风向已变化，可用状态失效，等待重算…</div>
      )}
      {node.status === "recomputing" && (
        <div className="inline-stale">安全距离重算中，预览与发布暂停…</div>
      )}

      <div className="editor-actions">
        <button className="danger" onClick={() => store.deleteNode(node.id)}>
          删除节点
        </button>
      </div>
    </div>
  );
}

/* ---------------- 段落与放行 ---------------- */

export function SegmentPanel({ doc }: { doc: DocState }) {
  const [name, setName] = useState("");
  const [musicTime, setMusicTime] = useState("");

  const add = () => {
    if (!name.trim()) return;
    store.addSegment(name.trim(), musicTime.trim() || "00:00.000");
    setName("");
    setMusicTime("");
  };

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>节目段落</p>
          <h3>段落与安全员放行</h3>
        </div>
      </div>
      <div className="seg-list">
        {doc.segments.map((seg) => {
          const count = doc.nodes.filter((n) => n.segmentId === seg.id).length;
          return (
            <div className={`seg-row ${seg.approved ? "seg-approved" : ""}`} key={seg.id}>
              <div className="seg-main">
                <strong>{seg.name}</strong>
                <span className="seg-meta">
                  音乐点 {seg.musicTime} · {count} 个节点
                </span>
              </div>
              <div className="seg-actions">
                {seg.approved ? (
                  <>
                    <span className="badge badge-approved">已放行锁定</span>
                    <button onClick={() => store.revokeSegment(seg.id)}>撤销放行</button>
                  </>
                ) : (
                  <button className="primary" onClick={() => store.approveSegment(seg.id)}>
                    安全员放行
                  </button>
                )}
                <button onClick={() => store.addNode(seg.id)}>+ 节点</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="field-grid add-form">
        <label>
          <span>新段落名称</span>
          <input value={name} placeholder="如：Bridge" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>音乐时间点</span>
          <input value={musicTime} placeholder="00:12.500" onChange={(e) => setMusicTime(e.target.value)} />
        </label>
      </div>
      <button className="primary add-btn" onClick={add}>
        新增段落
      </button>
    </div>
  );
}

/* ---------------- 型号清单 ---------------- */

const CATEGORIES: Category[] = ["礼花弹", "罗马烛光", "扇形架", "冷焰火"];

export function ModelLibrary({ doc }: { doc: DocState }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("礼花弹");
  const [caliber, setCaliber] = useState("50");
  const [safety, setSafety] = useState("30");

  const add = () => {
    if (!name.trim()) return;
    store.addModel(name.trim(), category, Number(caliber) || 0, Number(safety) || 0);
    setName("");
  };

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>型号清单</p>
          <h3>烟花型号库</h3>
        </div>
      </div>
      <div className="model-grid">
        {doc.models.map((m) => (
          <article key={m.id} className="model-card">
            <strong>{m.name}</strong>
            <span className="badge badge-cat">{m.category}</span>
            <p>
              口径 {m.caliber}mm · 安全距离 {m.safetyDistance}m
            </p>
          </article>
        ))}
      </div>
      <div className="field-grid add-form">
        <label>
          <span>型号名称</span>
          <input value={name} placeholder="如：50mm礼花弹" onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>类别</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>口径（mm）</span>
          <input type="number" value={caliber} onChange={(e) => setCaliber(e.target.value)} />
        </label>
        <label>
          <span>安全距离（m）</span>
          <input type="number" value={safety} onChange={(e) => setSafety(e.target.value)} />
        </label>
      </div>
      <button className="primary add-btn" onClick={add}>
        新增型号
      </button>
    </div>
  );
}

/* ---------------- 发布中心 ---------------- */

export function PublishCenter() {
  const ui = useStore();
  const { doc, publish } = ui;
  const stale = doc.nodes.filter((n) => n.status === "stale" || n.status === "recomputing").length;
  const blocked = doc.nodes.filter((n) => n.status === "blocked").length;
  const unapproved = doc.segments.filter((s) => !s.approved).length;

  const checks = [
    { ok: !ui.recomputing, text: ui.recomputing ? "安全距离重算未完成，整场预览与发布已暂停" : "安全距离重算已完成" },
    { ok: ui.conflicts.length === 0, text: ui.conflicts.length ? `存在 ${ui.conflicts.length} 个并发冲突未处理` : "无并发冲突" },
    { ok: stale === 0, text: stale ? `${stale} 个节点可用状态已失效` : "全部节点可用状态有效" },
    { ok: blocked === 0, text: blocked ? `${blocked} 个节点安全距离受限` : "无安全距离受限节点" },
    { ok: unapproved === 0, text: unapproved ? `${unapproved} 个段落未经安全员放行` : "全部段落已经安全员放行" },
  ];
  const ready = checks.every((c) => c.ok) && publish.status !== "publishing";

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>发布包写入本地存储</p>
          <h3>发布中心</h3>
        </div>
      </div>

      <ul className="checklist">
        {checks.map((c, i) => (
          <li key={i} className={c.ok ? "check-ok" : "check-no"}>
            <span>{c.ok ? "✓" : "✕"}</span>
            {c.text}
          </li>
        ))}
      </ul>

      <label className="chaos-switch">
        <input type="checkbox" checked={ui.chaos} onChange={() => store.toggleChaos()} />
        <span>模拟写入故障（验证从上次完整版本恢复，半成品不会被当作已发布）</span>
      </label>

      <div className="publish-versions">
        <div>
          <small>当前已发布</small>
          <strong>{publish.currentVersion ? `v${publish.currentVersion}` : "无"}</strong>
          {publish.lastPublishedAt && <em>{new Date(publish.lastPublishedAt).toLocaleString()}</em>}
        </div>
        <div>
          <small>备份完整版本</small>
          <strong>{publish.backupVersion ? `v${publish.backupVersion}` : "无"}</strong>
        </div>
      </div>

      <button className="primary publish-btn" disabled={!ready} onClick={() => void store.publish()}>
        {publish.status === "publishing" ? "发布中…" : "发布整场脚本"}
      </button>

      <div className="publish-log">
        {publish.log.length === 0 && <p className="log-empty">暂无发布记录。</p>}
        {publish.log.map((l) => (
          <p key={l.id} className={`log-${l.kind}`}>
            <span>{new Date(l.at).toLocaleTimeString()}</span> {l.text}
          </p>
        ))}
      </div>
    </div>
  );
}

/* ---------------- 整场预览 ---------------- */

export function PreviewModal({ doc, onClose }: { doc: DocState; onClose: () => void }) {
  const nodes = [...doc.nodes].sort((a, b) => a.fireTime - b.fireTime);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="heading">
          <div>
            <p>整场节目预览</p>
            <h3>燃放脚本总览</h3>
          </div>
          <button onClick={onClose}>关闭</button>
        </div>
        <table className="preview-table">
          <thead>
            <tr>
              <th>点火时间</th>
              <th>段落</th>
              <th>点位</th>
              <th>型号</th>
              <th>口径</th>
              <th>方位角</th>
              <th>有效安全距离</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => {
              const seg = segmentOf(doc, n);
              const p = pointOf(doc, n);
              const m = modelOf(doc, n);
              return (
                <tr key={n.id}>
                  <td>{formatTime(n.fireTime)}</td>
                  <td>{seg?.name}</td>
                  <td>{p?.name}</td>
                  <td>{m?.name}</td>
                  <td>{m?.caliber}mm</td>
                  <td>{n.angle}°</td>
                  <td>{n.status === "blocked" || n.status === "available" ? `${n.effectiveSafety}m` : "—"}</td>
                  <td><StatusBadge status={n.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
