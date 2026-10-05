import { useStore } from "../store";
import type { Role } from "../types";

const ROLES: { id: Role; name: string }[] = [
  { id: "choreographer", name: "编排师" },
  { id: "pointLead", name: "点位负责人" },
  { id: "safety", name: "安全员" },
];

export function Header() {
  const { doc, role, setRole, lastPublish, calc } = useStore();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">✦</span>
        <div>
          <h1>烟花燃放脚本编排台</h1>
          <small>
            工作稿 v{doc.version} · 存储于本地 {lastPublish
              ? `· 已发布 ${lastPublish.packageId}`
              : "· 尚无已发布版本"}
          </small>
        </div>
      </div>

      <div className={`recalc-pill ${calc.phase}`}>
        {calc.phase === "idle" ? (
          <>● 安全核算已完成</>
        ) : calc.phase === "pending" ? (
          <>◷ 变更已失效，等待重算…</>
        ) : (
          <>
            <span className="spin" /> 重算中 {calc.done}/{calc.total}
          </>
        )}
      </div>

      <div className="role-switch" role="radiogroup" aria-label="当前角色">
        {ROLES.map((r) => (
          <button
            key={r.id}
            role="radio"
            aria-checked={role === r.id}
            className={role === r.id ? "active " + r.id : r.id}
            onClick={() => setRole(r.id)}
          >
            {r.name}
          </button>
        ))}
      </div>
    </header>
  );
}

export function GateBanner() {
  const { blocked, calcBusy, publishReady } = useStore();
  if (!calcBusy && publishReady) {
    return (
      <div className="gate ok">
        <b>✓ 全场可发布</b>
        <span>重算完成、节点全部可用、段落全部放行锁定。</span>
      </div>
    );
  }
  return (
    <div className={"gate " + (calcBusy ? "holding" : "error")}>
      <b>{calcBusy ? "⛔ 预览与发布已停住" : "⛔ 不满足发布条件"}</b>
      <ul>
        {blocked.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    </div>
  );
}
