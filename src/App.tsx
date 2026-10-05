import { StoreProvider, useStore } from "./store";
import { Header, GateBanner } from "./components/Header";
import { SiteMap } from "./components/SiteMap";
import { SegmentsPanel } from "./components/SegmentsPanel";
import { NodeEditor } from "./components/NodeEditor";
import { PreviewPublish } from "./components/PreviewPublish";
import { ConflictCenter } from "./components/ConflictCenter";

function Toasts() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={"toast " + t.kind} onClick={() => dismissToast(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

function Workspace() {
  return (
    <div className="page">
      <Header />
      <GateBanner />
      <div className="grid">
        <div className="col col-left">
          <SegmentsPanel />
        </div>
        <div className="col col-mid">
          <SiteMap />
          <NodeEditor />
        </div>
        <div className="col col-right">
          <PreviewPublish />
          <ConflictCenter />
        </div>
      </div>
      <Toasts />
      <footer className="foot">
        角色分工：编排师维护段落/节点（型号·角度·点火时间） · 点位负责人拖动点位与更新气象 ·
        安全员核算完成后放行锁定并发布。双开浏览器标签即可体验真实并发与冲突。
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Workspace />
    </StoreProvider>
  );
}
