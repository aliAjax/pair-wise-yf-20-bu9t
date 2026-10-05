import { useMemo, useState } from "react";
import { store, useStore } from "./store";
import { WIND_DIRS } from "./logic";
import type { Wind } from "./types";
import {
  MapView,
  Timeline,
  NodeEditor,
  SegmentPanel,
  ModelLibrary,
  PublishCenter,
  PreviewModal,
} from "./components";

const TABS = [
  { key: "timeline", label: "时间轴编排" },
  { key: "map", label: "点位平面图" },
  { key: "models", label: "型号清单" },
  { key: "publish", label: "发布中心" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function App() {
  const ui = useStore();
  const { doc } = ui;
  const [tab, setTab] = useState<TabKey>("timeline");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const selectedNodeId = useMemo(() => {
    if (selectedId && doc.nodes.some((n) => n.id === selectedId)) return selectedId;
    return null;
  }, [selectedId, doc.nodes]);

  const stale = doc.nodes.filter((n) => n.status === "stale" || n.status === "recomputing").length;
  const blocked = doc.nodes.filter((n) => n.status === "blocked").length;
  const unapproved = doc.segments.filter((s) => !s.approved).length;

  const previewBlock = ui.recomputing ? "安全距离重算未完成，预览已暂停" : null;
  const publishBlock = ui.recomputing
    ? "安全距离重算未完成，发布已暂停"
    : ui.conflicts.length
      ? "存在未处理的并发冲突"
      : stale
        ? "存在已失效节点，等待重算完成"
        : blocked
          ? "存在安全距离受限节点"
          : unapproved
            ? "存在未经安全员放行的段落"
            : null;

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62008 · 烟花燃放脚本编排</p>
        <h1>燃放脚本编排台</h1>
        <span>
          节目段落、点火节点与点位协同编排：节点绑定型号、发射角度与安全距离；点位或风向变化即触发可用状态重算，
          重算期间整场预览与发布暂停；安全员放行后段落锁定，多窗口并发修改自动检测冲突并保留原段落；发布包写入本地存储，
          写入失败可从上次完整版本恢复。
        </span>
      </section>

      <section className="panel globalbar">
        <label className="wind-select">
          <span>风向（吹向）</span>
          <select
            value={doc.wind}
            onChange={(e) => store.setWind(e.target.value as Wind)}
          >
            {WIND_DIRS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>

        <div className={`recompute-badge ${ui.recomputing ? "on" : ""}`}>
          {ui.recomputing ? (
            <>
              <span className="spinner" />
              安全距离重算中 · 预览与发布已暂停
            </>
          ) : (
            "可用状态已更新"
          )}
        </div>

        <div className="global-stats">
          <span>段落 {doc.segments.length}</span>
          <span>节点 {doc.nodes.length}</span>
          <span className={blocked ? "stat-no" : ""}>受限 {blocked}</span>
          <span className={stale ? "stat-no" : ""}>待重算 {stale}</span>
        </div>

        <div className="global-actions">
          <button
            disabled={!!previewBlock}
            title={previewBlock ?? "查看整场节目预览"}
            onClick={() => setPreviewOpen(true)}
          >
            整场预览
          </button>
          <button
            className="primary"
            disabled={!!publishBlock}
            title={publishBlock ?? "发布整场脚本到本地存储"}
            onClick={() => setTab("publish")}
          >
            发布脚本
          </button>
        </div>
      </section>

      {(ui.lockMsg || ui.conflicts.length > 0) && (
        <section className="banners">
          {ui.lockMsg && (
            <div className="banner banner-lock">
              <strong>操作被拦截</strong>
              <span>{ui.lockMsg}</span>
              <button onClick={() => store.clearLock()}>知道了</button>
            </div>
          )}
          {ui.conflicts.map((c) => (
            <div className="banner banner-conflict" key={c.id}>
              <strong>并发冲突</strong>
              <span>
                {c.nodeName} 已被另一窗口抢先修改，您的修改未生效，原段落已保留。请刷新后基于最新版本再改。
              </span>
              <button onClick={() => store.dismissConflict(c.id)}>知道了</button>
            </div>
          ))}
        </section>
      )}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "tab active" : "tab"}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "timeline" && (
        <div className="tab-grid">
          <div className="tab-main">
            <section className="panel">
              <div className="heading">
                <div>
                  <p>时间轴</p>
                  <h2>节目段落 × 点火节点</h2>
                </div>
              </div>
              <Timeline
                doc={doc}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedId}
              />
            </section>
            <SegmentPanel doc={doc} />
          </div>
          <div className="tab-side">
            <NodeEditor doc={doc} nodeId={selectedNodeId} />
          </div>
        </div>
      )}

      {tab === "map" && (
        <section className="panel">
          <div className="heading">
            <div>
              <p>燃放点位平面图</p>
              <h2>点位与节点布局</h2>
            </div>
          </div>
          <MapView
            doc={doc}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedId}
          />
        </section>
      )}

      {tab === "models" && <ModelLibrary doc={doc} />}

      {tab === "publish" && <PublishCenter />}

      {previewOpen && !previewBlock && (
        <PreviewModal doc={doc} onClose={() => setPreviewOpen(false)} />
      )}
    </main>
  );
}
