import { useStore } from "../store";
import { formatMs } from "../domain";

export function PreviewPublish() {
  const {
    doc,
    role,
    previewReady,
    publishReady,
    calc,
    calcBusy,
    blocked,
    publish,
    armFailure,
    lastPublish,
  } = useStore();

  const timeline = [...doc.nodes].sort((a, b) => a.igniteAtMs - b.igniteAtMs);
  const endMs = timeline.reduce((mx, n) => {
    const m = doc.models.find((x) => x.id === n.modelId);
    return Math.max(mx, n.igniteAtMs + (m?.durationMs ?? 0));
  }, 0);

  return (
    <section className="panel preview">
      <div className="panel-head">
        <h2>整场预览 · 发布</h2>
        <small>重算未完成时预览与发布一律停住</small>
      </div>

      {!previewReady ? (
        <div className="preview-hold">
          <div className="big-spin" />
          <h3>重算未完成，预览停住</h3>
          <p>
            {calc.phase === "pending" ? "变更已提交，等待安全核算开始…" : `正在核算节点 ${calc.done}/${calc.total}…`}
          </p>
        </div>
      ) : (
        <>
          <div className="timeline">
            <div className="tl-axis">
              {timeline.map((n) => {
                const model = doc.models.find((m) => m.id === n.modelId);
                const seg = doc.segments.find((s) => s.id === n.segmentId);
                const left = endMs ? (n.igniteAtMs / endMs) * 100 : 0;
                const width = endMs ? ((model?.durationMs ?? 0) / endMs) * 100 : 0;
                return (
                  <div
                    key={n.id}
                    className={"tl-cue " + n.avail}
                    style={{ left: left + "%", width: Math.max(width, 0.8) + "%" }}
                    title={`${formatMs(n.igniteAtMs)} ${n.label}（${seg?.name}）`}
                  />
                );
              })}
            </div>
            <ul className="tl-rows">
              {timeline.map((n) => {
                const seg = doc.segments.find((s) => s.id === n.segmentId);
                return (
                  <li key={n.id}>
                    <span className="timecode">{formatMs(n.igniteAtMs)}</span>
                    <span className={"tl-dot " + n.avail} />
                    <span className="node-label">{n.label}</span>
                    <small>
                      {seg?.name} ·{" "}
                      {n.avail === "available"
                        ? "可燃放"
                        : n.failReasons.join("；") || "不可用"}
                    </small>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="publish-box">
            <div className="checklist">
              {[
                {
                  ok: !calcBusy,
                  text: calcBusy
                    ? `安全重算进行中（${calc.done}/${calc.total}）`
                    : "安全重算已完成",
                },
                {
                  ok: doc.nodes.every((n) => n.avail === "available"),
                  text: `${doc.nodes.filter((n) => n.avail === "available").length}/${doc.nodes.length} 节点安全可用`,
                },
                {
                  ok: doc.segments.every((s) => doc.approvals[s.id]?.status === "approved"),
                  text: `${doc.segments.filter((s) => doc.approvals[s.id]?.status === "approved").length}/${doc.segments.length} 段落已放行锁定`,
                },
              ].map((c) => (
                <div key={c.text} className={"check " + (c.ok ? "ok" : "no")}>
                  {c.ok ? "✓" : "✗"} {c.text}
                </div>
              ))}
            </div>

            {blocked.length > 0 && (
              <ul className="blocked-list">
                {blocked.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}

            <div className="publish-actions">
              <button
                className="primary big"
                disabled={role !== "safety" || !publishReady}
                title={
                  role !== "safety"
                    ? "仅安全员可发布"
                    : !publishReady
                      ? "满足全部检查项后才能发布"
                      : "原子写入本地存储"
                }
                onClick={() => publish()}
              >
                发布到本地存储
              </button>
              <button className="small ghost" onClick={armFailure} title="注入一次写入失败，验证不会把半份脚本当作已发布">
                🧪 模拟下次写入失败
              </button>
            </div>

            <small className="muted">
              {lastPublish
                ? `当前完整发布版本：${lastPublish.packageId}（v${lastPublish.docVersion}，${new Date(lastPublish.publishedAt).toLocaleTimeString()}，校验 ${lastPublish.checksum}）`
                : "尚无完整发布版本。发布采用「阶段包 → 校验 → 正式包」原子流程，失败自动回滚到上次完整版本。"}
            </small>
          </div>
        </>
      )}
    </section>
  );
}
