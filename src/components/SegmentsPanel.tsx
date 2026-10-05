import { useStore } from "../store";
import { formatMs } from "../domain";
import type { CueNode } from "../types";

function StateBadge({ node }: { node: CueNode }) {
  if (node.avail === "unknown") return <span className="badge wait">待重算</span>;
  if (node.avail === "available") return <span className="badge ok">可用</span>;
  return (
    <span className="badge bad" title={node.failReasons.join("；")}>
      不可用
    </span>
  );
}

export function SegmentsPanel() {
  const {
    doc,
    role,
    nodesBySegment,
    selectedNodeId,
    setSelectedNodeId,
    selectedSegmentId,
    setSelectedSegmentId,
    approveSegment,
    revokeSegment,
    addNode,
    addSegment,
    calcBusy,
  } = useStore();

  const sorted = [...doc.segments].sort((a, b) => a.order - b.order);

  return (
    <section className="panel segments">
      <div className="panel-head">
        <h2>节目段落 · 点火节点</h2>
        <button className="small" disabled={role !== "choreographer"} onClick={addSegment}>
          + 新段落
        </button>
      </div>

      <div className="seg-list">
        {sorted.map((seg) => {
          const nodes = (nodesBySegment.get(seg.id) ?? []).sort(
            (a, b) => a.igniteAtMs - b.igniteAtMs,
          );
          const approval = doc.approvals[seg.id];
          const locked = approval?.status === "approved";
          const active = selectedSegmentId === seg.id;
          const allGood = nodes.length > 0 && nodes.every((n) => n.avail === "available");

          return (
            <article
              key={seg.id}
              className={"seg " + (active ? "active" : "") + (locked ? " locked" : "")}
              onClick={() => setSelectedSegmentId(seg.id)}
            >
              <header className="seg-head">
                <div className="seg-title">
                  <h3>{seg.name}</h3>
                  {seg.note && <small>{seg.note}</small>}
                </div>
                {locked ? (
                  <div className="lock-box">
                    <span className="locked-tag">🔒 已放行锁定</span>
                    <button
                      className="small warn"
                      disabled={role !== "safety"}
                      onClick={(e) => {
                        e.stopPropagation();
                        revokeSegment(seg.id);
                      }}
                    >
                      撤销放行
                    </button>
                  </div>
                ) : (
                  <button
                    className="small approve"
                    disabled={role !== "safety" || calcBusy || !allGood}
                    title={
                      role !== "safety"
                        ? "仅安全员可放行"
                        : !allGood
                          ? "段落内节点未全部通过核算"
                          : "安全员放行并锁定段落"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      approveSegment(seg.id);
                    }}
                  >
                    安全员放行
                  </button>
                )}
              </header>

              <ul className="node-rows">
                {nodes.map((n) => {
                  const model = doc.models.find((m) => m.id === n.modelId);
                  const pos = doc.positions.find((p) => p.id === n.positionId);
                  return (
                    <li
                      key={n.id}
                      className={"node-row " + (n.id === selectedNodeId ? "sel" : "")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedNodeId(n.id);
                        setSelectedSegmentId(seg.id);
                      }}
                    >
                      <span className="timecode">{formatMs(n.igniteAtMs)}</span>
                      <span className="node-label">{n.label}</span>
                      <span className="node-meta">
                        {model?.name} · {pos?.name} · 仰角{n.launchAngleDeg}°
                      </span>
                      <StateBadge node={n} />
                    </li>
                  );
                })}
                {nodes.length === 0 && <li className="empty">空段落：尚无点火节点</li>}
              </ul>

              <button
                className="small ghost add-node"
                disabled={role !== "choreographer" || locked}
                onClick={(e) => {
                  e.stopPropagation();
                  addNode(seg.id);
                }}
              >
                + 在此段落新增节点
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
