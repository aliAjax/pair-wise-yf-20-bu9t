import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { evaluateNode, formatMs, parseTime } from "../domain";
import type { IncomingChange } from "../types";

interface Draft {
  label: string;
  segmentId: string;
  positionId: string;
  modelId: string;
  launchAngleDeg: number;
  azimuthDeg: number;
  timeText: string;
}

export function NodeEditor() {
  const {
    doc,
    role,
    selectedNodeId,
    updateNode,
    calcCtx,
    calcBusy,
    conflicts,
    dismissConflict,
  } = useStore();

  const node = doc.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const segment = node ? doc.segments.find((s) => s.id === node.segmentId) : null;
  const locked = segment ? doc.approvals[segment.id]?.status === "approved" : false;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const [localConflict, setLocalConflict] = useState<string | null>(null);
  const [timeError, setTimeError] = useState(false);

  // 其他入口（第二窗口同步、并发模拟）产生的选中节点冲突
  const externalConflict = conflicts.find((c) => c.nodeId === selectedNodeId) ?? null;

  // 切换节点或节点版本被其他窗口推进时，重置草稿与本地冲突提示
  useEffect(() => {
    if (!node) {
      setDraft(null);
      setLocalConflict(null);
      return;
    }
    setDraft({
      label: node.label,
      segmentId: node.segmentId,
      positionId: node.positionId,
      modelId: node.modelId,
      launchAngleDeg: node.launchAngleDeg,
      azimuthDeg: node.azimuthDeg,
      timeText: formatMs(node.igniteAtMs),
    });
    setBaseVersion(node.nodeVersion);
    setLocalConflict(null);
    setTimeError(false);
  }, [node?.id, node?.nodeVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const livePreview = useMemo(() => {
    if (!node || !draft) return null;
    const whatIf = {
      ...node,
      positionId: draft.positionId,
      modelId: draft.modelId,
      launchAngleDeg: draft.launchAngleDeg,
      azimuthDeg: draft.azimuthDeg,
    };
    return evaluateNode(whatIf, calcCtx);
  }, [node, draft, calcCtx]);

  if (!node || !draft || !segment) {
    return (
      <section className="panel editor">
        <div className="panel-head"><h2>节点详情</h2></div>
        <p className="empty">从左侧段落或平面图选择一个点火节点。</p>
      </section>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = () => {
    const ms = parseTime(draft.timeText);
    if (ms === null) {
      setTimeError(true);
      return;
    }
    const patch: IncomingChange = {
      label: draft.label,
      segmentId: draft.segmentId,
      positionId: draft.positionId,
      modelId: draft.modelId,
      launchAngleDeg: draft.launchAngleDeg,
      azimuthDeg: draft.azimuthDeg,
      igniteAtMs: ms,
    };
    const result = updateNode(node.id, patch, baseVersion);
    if (result.conflict) {
      setLocalConflict(result.reason ?? "与另一窗口的修改冲突");
      return;
    }
    if (result.ok) setLocalConflict(null);
  };

  const dirty =
    draft.label !== node.label ||
    draft.segmentId !== node.segmentId ||
    draft.positionId !== node.positionId ||
    draft.modelId !== node.modelId ||
    draft.launchAngleDeg !== node.launchAngleDeg ||
    draft.azimuthDeg !== node.azimuthDeg ||
    draft.timeText !== formatMs(node.igniteAtMs);

  const readonly = role !== "choreographer" || locked;
  const otherSegments = [...doc.segments].sort((a, b) => a.order - b.order);

  return (
    <section className="panel editor">
      <div className="panel-head">
        <h2>节点详情</h2>
        <small>
          {node.id} · 内容版本 v{node.nodeVersion}
        </small>
      </div>

      {locked && (
        <div className="notice warn">
          🔒 段落「{segment.name}」已被安全员放行锁定，节点只读；需安全员先撤销放行。
        </div>
      )}
      {role !== "choreographer" && !locked && (
        <div className="notice info">当前身份为{role === "safety" ? "安全员" : "点位负责人"}，节点字段由编排师维护。</div>
      )}
      {(localConflict || externalConflict) && (
        <div className="notice conflict">
          <b>并发修改冲突</b>
          <p>{localConflict ?? externalConflict!.detail}</p>
          <div className="conflict-actions">
            <button
              className="small"
              onClick={() => {
                // 放弃本地表单内容，按最新版本重新编辑
                setDraft({
                  label: node.label,
                  segmentId: node.segmentId,
                  positionId: node.positionId,
                  modelId: node.modelId,
                  launchAngleDeg: node.launchAngleDeg,
                  azimuthDeg: node.azimuthDeg,
                  timeText: formatMs(node.igniteAtMs),
                });
                setBaseVersion(node.nodeVersion);
                setLocalConflict(null);
                if (externalConflict) dismissConflict(externalConflict.id);
              }}
            >
              采用最新版本（我稍后再改）
            </button>
            <button
              className="small primary"
              onClick={() => {
                // 在最新版本之上重做本地修改（原段落仍以服务端为准，避免抢段落）
                if (externalConflict) dismissConflict(externalConflict.id);
                setBaseVersion(node.nodeVersion);
                setLocalConflict(null);
                save();
              }}
            >
              以最新版本为基础重试
            </button>
          </div>
        </div>
      )}

      <div className="form">
        <label className="full">
          <span>节点名称</span>
          <input
            value={draft.label}
            disabled={readonly}
            onChange={(e) => set("label", e.target.value)}
          />
        </label>

        <label>
          <span>所属段落</span>
          <select
            value={draft.segmentId}
            disabled={readonly}
            onChange={(e) => set("segmentId", e.target.value)}
          >
            {otherSegments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>绑定型号</span>
          <select
            value={draft.modelId}
            disabled={readonly}
            onChange={(e) => set("modelId", e.target.value)}
          >
            {doc.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}（安全距离 {m.requiredDistanceM}m）
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>发射点位</span>
          <select
            value={draft.positionId}
            disabled={readonly}
            onChange={(e) => set("positionId", e.target.value)}
          >
            {doc.positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>发射仰角（90°垂直）</span>
          <input
            type="number"
            min={45}
            max={90}
            value={draft.launchAngleDeg}
            disabled={readonly}
            onChange={(e) => set("launchAngleDeg", Number(e.target.value))}
          />
        </label>

        <label>
          <span>发射方位角（0=东）</span>
          <input
            type="number"
            min={0}
            max={360}
            value={draft.azimuthDeg}
            disabled={readonly}
            onChange={(e) => set("azimuthDeg", Number(e.target.value))}
          />
        </label>

        <label className={timeError ? "bad" : ""}>
          <span>点火时间 mm:ss.mmm</span>
          <input
            value={draft.timeText}
            disabled={readonly}
            onChange={(e) => {
              set("timeText", e.target.value);
              setTimeError(false);
            }}
          />
          {timeError && <small className="err-text">时间格式不正确，例 01:08.200</small>}
        </label>
      </div>

      <div className={"preview-geometry " + (livePreview?.avail ? "ok" : "bad")}>
        <b>即时安全试算（当前风向）：</b>
        {livePreview && (
          <>
            有效余量 {livePreview.geometry.effectiveClearanceM.toFixed(0)}m ·
            型号要求 {doc.models.find((m) => m.id === draft.modelId)?.requiredDistanceM}m
            {livePreview.reasons.length > 0 && (
              <em> — {livePreview.reasons.join("；")}</em>
            )}
          </>
        )}
        {calcBusy && <span className="muted">（全场重算进行中，提交后以正式重算为准）</span>}
      </div>

      <div className="editor-actions">
        <button className="primary" disabled={readonly || !dirty} onClick={save}>
          保存节点（触发受影响节点重算）
        </button>
      </div>
    </section>
  );
}
