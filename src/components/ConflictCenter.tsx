import { useState } from "react";
import { useStore } from "../store";

function fmt(at: number) {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false });
}

export function ConflictCenter() {
  const {
    doc,
    role,
    selectedNodeId,
    setSelectedNodeId,
    conflicts,
    dismissConflict,
    events,
    simulateConcurrentEdit,
  } = useStore();

  const [simText, setSimText] = useState("本窗口晚到的改名");
  const [simSegmentId, setSimSegmentId] = useState("");
  const node = doc.nodes.find((n) => n.id === selectedNodeId) ?? null;

  return (
    <section className="panel conflicts">
      <div className="panel-head">
        <h2>并发冲突 · 发布审计</h2>
      </div>

      <div className="sim-box">
        <h3>🧪 双窗口并发模拟</h3>
        <p>
          真实双开两个浏览器标签页会通过 <code>storage</code> 事件实时同步。这里直接模拟：
          第二窗口先保存同一节点，本窗口随后基于旧版本提交。
        </p>
        <div className="sim-row">
          <select value={selectedNodeId ?? ""} onChange={(e) => setSelectedNodeId(e.target.value)}>
            {doc.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}（{n.id} v{n.nodeVersion}）
              </option>
            ))}
          </select>
          <input
            placeholder="晚到修改：节点改名"
            value={simText}
            onChange={(e) => setSimText(e.target.value)}
          />
          <select value={simSegmentId} onChange={(e) => setSimSegmentId(e.target.value)}>
            <option value="">晚到修改：尝试改到段落…</option>
            {doc.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            className="small primary"
            disabled={role !== "choreographer" || !node}
            title={role !== "choreographer" ? "切换到编排师身份" : "模拟并发保存"}
            onClick={() =>
              node &&
              simulateConcurrentEdit(
                node.id,
                {
                  label: simText || "本窗口晚到的改名",
                  ...(simSegmentId ? { segmentId: simSegmentId } : {}),
                },
                node.nodeVersion,
              )
            }
          >
            模拟两个窗口同时保存
          </button>
        </div>
        <small className="muted">
          冲突时晚到修改被拒绝，节点保留在原段落；冲突会在此处留痕，可选择“以最新版本重试”。
        </small>
      </div>

      <h3>冲突记录（{conflicts.length}）</h3>
      {conflicts.length === 0 ? (
        <p className="empty">暂无并发冲突。</p>
      ) : (
        <ul className="conflict-list">
          {conflicts.map((c) => (
            <li key={c.id}>
              <header>
                <b>{c.nodeLabel}</b>
                <time>
                  {fmt(c.at)} · v{c.baseVersion} → v{c.currentVersion}
                </time>
                <button className="tiny" onClick={() => dismissConflict(c.id)}>
                  清除
                </button>
              </header>
              <p>{c.detail}</p>
              <small>
                晚到内容：
                {[
                  c.incoming.label ? `名称「${c.incoming.label}」` : null,
                  c.incoming.segmentId ? `段落「${c.incoming.segmentId}」` : null,
                ]
                  .filter(Boolean)
                  .join("，")}
                （未写入）
              </small>
            </li>
          ))}
        </ul>
      )}

      <h3>发布与恢复审计</h3>
      <ul className="event-log">
        {events.slice(0, 12).map((e, i) => (
          <li key={i} className={e.level}>
            <time>{fmt(e.at)}</time>
            <span>{e.message}</span>
          </li>
        ))}
        {events.length === 0 && <li className="empty">暂无审计记录。</li>}
      </ul>
    </section>
  );
}
