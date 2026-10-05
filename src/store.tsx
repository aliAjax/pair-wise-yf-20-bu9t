import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CalcProgress,
  ConflictNotice,
  CueNode,
  IncomingChange,
  Position,
  PublishedPackage,
  Role,
  ScriptDoc,
  WindState,
} from "./types";
import { evaluateNode, nodeSignature, type CalcContext } from "./domain";
import {
  appendEvent,
  armFailNextWrite,
  bootStorage,
  loadDoc,
  loadEvents,
  loadPublished,
  publishAtomic,
  saveDoc,
  type StoredEvent,
} from "./storage";

bootStorage();

const DOC_KEY = "fireworks.doc.v1";

export interface Toast {
  id: number;
  kind: "ok" | "warn" | "error";
  message: string;
}

interface ActionResult {
  ok: boolean;
  reason?: string;
  conflict?: boolean;
}

interface StoreValue {
  doc: ScriptDoc;
  role: Role;
  setRole: (r: Role) => void;
  calc: CalcProgress;
  conflicts: ConflictNotice[];
  events: StoredEvent[];
  toasts: Toast[];
  dismissToast: (id: number) => void;
  lastPublish: PublishedPackage | null;
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  selectedSegmentId: string | null;
  setSelectedSegmentId: (id: string | null) => void;

  calcCtx: CalcContext;
  calcBusy: boolean;
  blocked: string[];
  previewReady: boolean;
  publishReady: boolean;
  nodesBySegment: Map<string, CueNode[]>;

  // 编排师
  updateNode: (nodeId: string, patch: IncomingChange, baseVersion: number) => ActionResult;
  addNode: (segmentId: string) => ActionResult;
  addSegment: () => ActionResult;
  /** 演示：另一窗口先提交，本窗口晚到修改撞版本 */
  simulateConcurrentEdit: (nodeId: string, latePatch: IncomingChange, baseVersion: number) => void;
  // 点位负责人
  movePosition: (positionId: string, x: number, y: number) => ActionResult;
  setWind: (wind: WindState) => ActionResult;
  // 安全员
  approveSegment: (segmentId: string) => ActionResult;
  revokeSegment: (segmentId: string) => ActionResult;
  publish: () => ActionResult & { pkg?: PublishedPackage; restoredPkg?: PublishedPackage };
  armFailure: () => void;

  dismissConflict: (id: string) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

let toastSeq = 1;
let conflictSeq = 1;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [doc, setDoc] = useState<ScriptDoc>(() => loadDoc());
  const [role, setRole] = useState<Role>("choreographer");
  const [calc, setCalc] = useState<CalcProgress>({ phase: "idle", done: 0, total: 0 });
  const [conflicts, setConflicts] = useState<ConflictNotice[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>(() => loadEvents());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastPublish, setLastPublish] = useState<PublishedPackage | null>(
    () => loadPublished()?.pkg ?? null,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("N1");
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>("S1");

  const docRef = useRef(doc);
  docRef.current = doc;
  const calcRef = useRef(calc);
  calcRef.current = calc;
  const roleRef = useRef(role);
  roleRef.current = role;
  const sigRef = useRef(new Map<string, string>());
  const runTokenRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const pushToast = useCallback((kind: Toast["kind"], message: string) => {
    const id = toastSeq++;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  const logEvent = useCallback(
    (level: StoredEvent["level"], message: string) => {
      setEvents(appendEvent(level, message));
    },
    [],
  );

  const calcCtx: CalcContext = useMemo(() => {
    const positions: Record<string, Position> = {};
    doc.positions.forEach((p) => (positions[p.id] = p));
    const models = Object.fromEntries(doc.models.map((m) => [m.id, m]));
    return { positions, models, audience: doc.audience, wind: doc.wind };
  }, [doc]);

  // ---------- 重算调度 ----------

  const scheduleRecalc = useCallback(() => {
    runTokenRef.current += 1;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(async () => {
      const token = runTokenRef.current;
      const snapshot = docRef.current;
      const ids = snapshot.nodes.filter((n) => n.avail === "unknown").map((n) => n.id);
      if (ids.length === 0) {
        setCalc({ phase: "idle", done: 0, total: 0 });
        return;
      }
      setCalc({ phase: "running", done: 0, total: ids.length });

      let done = 0;
      for (const id of ids) {
        // 让出主线程，制造可见的“重算中”窗口
        await new Promise((r) => window.setTimeout(r, 70));
        if (token !== runTokenRef.current) return; // 已被新变更取消

        const live = docRef.current;
        const node = live.nodes.find((n) => n.id === id);
        if (!node || node.avail !== "unknown") {
          done += 1;
          continue;
        }
        // 每步都从最新文档构建上下文，避免排队期间的再次编辑造成陈旧结论
        const livePositions: Record<string, Position> = {};
        live.positions.forEach((p) => (livePositions[p.id] = p));
        const liveCtx: CalcContext = {
          positions: livePositions,
          models: Object.fromEntries(live.models.map((m) => [m.id, m])),
          audience: live.audience,
          wind: live.wind,
        };
        const result = evaluateNode(node, liveCtx);
        sigRef.current.set(id, nodeSignature(node, liveCtx));

        setDoc((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.id === id
              ? {
                  ...n,
                  avail: result.avail ? "available" : "unavailable",
                  failReasons: result.reasons,
                }
              : n,
          ),
        }));
        done += 1;
        setCalc({ phase: "running", done, total: ids.length });
      }

      if (token === runTokenRef.current) {
        setCalc({ phase: "idle", done: ids.length, total: ids.length });
      }
    }, 280);
  }, []);

  /** 提交新文档：受影响节点立即置为“待重算”，预览/发布随即停住 */
  const commit = useCallback(
    (next: ScriptDoc, invalidate: "all" | Set<string>) => {
      const ids = invalidate === "all" ? new Set(next.nodes.map((n) => n.id)) : invalidate;
      if (ids.size > 0) {
        next = {
          ...next,
          nodes: next.nodes.map((n) =>
            ids.has(n.id) ? { ...n, avail: "unknown" as const, failReasons: [] } : n,
          ),
        };
        setCalc({ phase: "pending", done: 0, total: ids.size });
      }
      next.version += 1;
      next.updatedAt = Date.now();
      setDoc(next);
      if (ids.size > 0) scheduleRecalc();
    },
    [scheduleRecalc],
  );

  // 持久化工作脚本（派生结果回写不增加 version，这里的保存是幂等的）
  useEffect(() => {
    try {
      saveDoc(doc);
    } catch (e) {
      pushToast("error", `工作脚本写入本地失败：${(e as Error).message}`);
    }
  }, [doc, pushToast]);

  // 首屏先跑一次安全重算，未完成前预览/发布不可用
  useEffect(() => {
    const anyUnknown = docRef.current.nodes.some((n) => n.avail === "unknown");
    if (anyUnknown) {
      setCalc((c) => (c.phase === "idle" ? { phase: "pending", done: 0, total: 0 } : c));
      scheduleRecalc();
    }
    return () => {
      runTokenRef.current += 1;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 跨窗口同步 ----------

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DOC_KEY || !e.newValue) return;
      let incoming: ScriptDoc;
      try {
        incoming = JSON.parse(e.newValue) as ScriptDoc;
      } catch {
        return;
      }
      const old = docRef.current;
      if (incoming.version <= old.version) return;

      const oldPos = new Map(old.positions.map((p) => [p.id, `${p.x},${p.y}`]));
      const movedPositions = new Set(
        incoming.positions
          .filter((p) => oldPos.get(p.id) !== `${p.x},${p.y}`)
          .map((p) => p.id),
      );
      const windChanged =
        old.wind.deg !== incoming.wind.deg || old.wind.speedKmh !== incoming.wind.speedKmh;
      const oldVersions = new Map(old.nodes.map((n) => [n.id, n.nodeVersion]));

      const affected = new Set<string>();
      incoming.nodes.forEach((n) => {
        if (oldVersions.get(n.id) !== n.nodeVersion) affected.add(n.id);
        if (movedPositions.has(n.positionId)) affected.add(n.id);
        if (windChanged) affected.add(n.id);
      });

      incoming = {
        ...incoming,
        nodes: incoming.nodes.map((n) =>
          affected.has(n.id) ? { ...n, avail: "unknown", failReasons: [] } : n,
        ),
      };
      setDoc(incoming);
      if (affected.size > 0) {
        setCalc({ phase: "pending", done: 0, total: affected.size });
        scheduleRecalc();
      }
      pushToast("warn", `另一窗口已更新脚本（v${old.version} → v${incoming.version}），受影响节点重新核算`);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [pushToast, scheduleRecalc]);

  // ---------- 闸门派生 ----------

  const nodesBySegment = useMemo(() => {
    const map = new Map<string, CueNode[]>();
    doc.nodes.forEach((n) => {
      const list = map.get(n.segmentId) ?? [];
      list.push(n);
      map.set(n.segmentId, list);
    });
    return map;
  }, [doc.nodes]);

  const calcBusy = calc.phase !== "idle";
  const blocked = useMemo(() => {
    const reasons: string[] = [];
    if (calc.phase === "pending") reasons.push("安全重算排队中…");
    if (calc.phase === "running")
      reasons.push(`安全重算进行中（${calc.done}/${calc.total}），预览与发布已暂停`);
    const bad = doc.nodes.filter((n) => n.avail === "unavailable");
    if (bad.length > 0) reasons.push(`${bad.length} 个节点安全核算不通过`);
    const locked = doc.segments.filter((s) => doc.approvals[s.id]?.status !== "approved");
    if (locked.length > 0 && !calcBusy) reasons.push(`${locked.length} 个段落未经安全员放行锁定`);
    return reasons;
  }, [calc, doc, calcBusy]);

  const previewReady = !calcBusy;
  const publishReady =
    !calcBusy &&
    doc.nodes.length > 0 &&
    doc.nodes.every((n) => n.avail === "available") &&
    doc.segments.every((s) => doc.approvals[s.id]?.status === "approved");

  // ---------- 动作 ----------

  const requireRole = (r: Role, verb: string): ActionResult | null => {
    if (roleRef.current !== r) {
      const name: Record<Role, string> = {
        choreographer: "编排师",
        pointLead: "点位负责人",
        safety: "安全员",
      };
      const reason = `该操作需要${name[r]}身份（当前：${name[roleRef.current]}）：${verb}`;
      pushToast("warn", reason);
      return { ok: false, reason };
    }
    return null;
  };

  const updateNode: StoreValue["updateNode"] = (nodeId, patch, baseVersion) => {
    const guard = requireRole("choreographer", "修改点火节点");
    if (guard) return guard;

    const current = docRef.current.nodes.find((n) => n.id === nodeId);
    if (!current) return { ok: false, reason: "节点不存在" };

    // 乐观锁：另一窗口的写入先到，晚到修改被拒绝，原段落保留
    if (current.nodeVersion !== baseVersion) {
      const detail = `该节点在你的窗口打开后已被另一处修改（v${baseVersion} → v${current.nodeVersion}）。为避免覆盖，本次修改未写入，节点保留在原段落「${
        docRef.current.segments.find((s) => s.id === current.segmentId)?.name ?? current.segmentId
      }」。`;
      setConflicts((c) => [
        {
          id: `C${conflictSeq++}`,
          at: Date.now(),
          nodeId,
          nodeLabel: current.label,
          detail,
          baseVersion,
          currentVersion: current.nodeVersion,
          incoming: patch,
        },
        ...c,
      ]);
      pushToast("error", "冲突：该节点已被另一窗口修改，晚到的修改未保存");
      return { ok: false, conflict: true, reason: detail };
    }

    // 锁定段落：必须先由安全员撤销放行
    if (docRef.current.approvals[current.segmentId]?.status === "approved") {
      const segName = docRef.current.segments.find((s) => s.id === current.segmentId)?.name;
      const reason = `段落「${segName}」已放行锁定，需安全员先撤销放行才能改节点`;
      pushToast("warn", reason);
      return { ok: false, reason };
    }

    const affected = new Set<string>([nodeId]);
    // 换点位会影响新老两个点位上的齐射关系：同点位节点全部失效重算
    if (patch.positionId && patch.positionId !== current.positionId) {
      docRef.current.nodes.forEach((n) => {
        if (n.positionId === current.positionId || n.positionId === patch.positionId)
          affected.add(n.id);
      });
    }
    const next: ScriptDoc = {
      ...docRef.current,
      nodes: docRef.current.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              ...patch,
              nodeVersion: n.nodeVersion + 1,
            }
          : n,
      ),
    };
    commit(next, affected);
    pushToast("ok", `节点已修改，${affected.size} 个节点安全状态失效重算`);
    return { ok: true };
  };

  const addNode: StoreValue["addNode"] = (segmentId) => {
    const guard = requireRole("choreographer", "新增点火节点");
    if (guard) return guard;
    if (docRef.current.approvals[segmentId]?.status === "approved") {
      pushToast("warn", "段落已锁定，先撤销放行再新增节点");
      return { ok: false, reason: "段落已锁定" };
    }
    const nid = `N${Date.now().toString(36).toUpperCase()}`;
    const segNodes = docRef.current.nodes.filter((n) => n.segmentId === segmentId).length;
    const node: CueNode = {
      id: nid,
      label: `新节点 ${segNodes + 1}`,
      segmentId,
      positionId: docRef.current.positions[0].id,
      modelId: docRef.current.models[0].id,
      launchAngleDeg: 90,
      azimuthDeg: 0,
      igniteAtMs: 0,
      avail: "unknown",
      failReasons: [],
      nodeVersion: 1,
    };
    const affected = new Set<string>([nid]);
    docRef.current.nodes.forEach((n) =>
      n.positionId === node.positionId ? affected.add(n.id) : null,
    );
    commit({ ...docRef.current, nodes: [...docRef.current.nodes, node] }, affected);
    setSelectedNodeId(nid);
    return { ok: true };
  };

  const addSegment: StoreValue["addSegment"] = () => {
    const guard = requireRole("choreographer", "新增节目段落");
    if (guard) return guard;
    const id = `S${Date.now().toString(36).toUpperCase()}`;
    const order = docRef.current.segments.length;
    commit(
      {
        ...docRef.current,
        segments: [...docRef.current.segments, { id, name: `新段落 ${order + 1}`, order }],
        approvals: { ...docRef.current.approvals, [id]: { status: "pending" } },
      },
      new Set(),
    );
    setSelectedSegmentId(id);
    return { ok: true };
  };

  const simulateConcurrentEdit: StoreValue["simulateConcurrentEdit"] = (
    nodeId,
    latePatch,
    baseVersion,
  ) => {
    const current = docRef.current.nodes.find((n) => n.id === nodeId);
    if (!current) return;
    if (docRef.current.approvals[current.segmentId]?.status === "approved") {
      pushToast("warn", "节点所在段落已锁定，请先让安全员撤销放行再演示并发修改");
      return;
    }
    // 1) 另一窗口的修改先落库（只改名称，段落保持原样）
    const otherPatch: IncomingChange = { label: current.label + "｜另一窗口已改" };
    const next: ScriptDoc = {
      ...docRef.current,
      nodes: docRef.current.nodes.map((n) =>
        n.id === nodeId ? { ...n, ...otherPatch, nodeVersion: n.nodeVersion + 1 } : n,
      ),
    };
    commit(next, new Set());
    logEvent("warn", `模拟第二窗口先保存了节点 ${current.label}`);
    // 2) 本窗口基于旧版本晚到提交 → 冲突
    window.setTimeout(() => {
      updateNode(nodeId, latePatch, baseVersion);
    }, 120);
  };

  const movePosition: StoreValue["movePosition"] = (positionId, x, y) => {
    const guard = requireRole("pointLead", "调整点位");
    if (guard) return guard;

    // 该点位上只要有已放行段落的节点，就必须先撤销放行
    const lockedUsers = docRef.current.nodes.filter(
      (n) =>
        n.positionId === positionId &&
        docRef.current.approvals[n.segmentId]?.status === "approved",
    );
    if (lockedUsers.length > 0) {
      const segs = [
        ...new Set(
          lockedUsers.map(
            (n) => docRef.current.segments.find((s) => s.id === n.segmentId)?.name ?? n.segmentId,
          ),
        ),
      ];
      const reason = `点位上有已锁定段落（${segs.join("、")}）的节点，请先由安全员撤销放行`;
      pushToast("warn", reason);
      return { ok: false, reason };
    }

    const affected = new Set(
      docRef.current.nodes.filter((n) => n.positionId === positionId).map((n) => n.id),
    );
    if (affected.size === 0) {
      // 没有节点也要保存点位移动
      const next: ScriptDoc = {
        ...docRef.current,
        positions: docRef.current.positions.map((p) => (p.id === positionId ? { ...p, x, y } : p)),
      };
      commit(next, new Set());
      return { ok: true };
    }
    const next: ScriptDoc = {
      ...docRef.current,
      positions: docRef.current.positions.map((p) => (p.id === positionId ? { ...p, x, y } : p)),
    };
    commit(next, affected);
    return { ok: true };
  };

  const setWind: StoreValue["setWind"] = (wind) => {
    const guard = requireRole("pointLead", "更新风向风速");
    if (guard) return guard;
    if (wind.deg === docRef.current.wind.deg && wind.speedKmh === docRef.current.wind.speedKmh) {
      return { ok: true };
    }
    logEvent("warn", `风向/风速更新为 ${wind.deg}° / ${wind.speedKmh}km/h，全场节点失效重算`);
    commit({ ...docRef.current, wind }, "all");
    return { ok: true };
  };

  const approveSegment: StoreValue["approveSegment"] = (segmentId) => {
    const guard = requireRole("safety", "放行段落");
    if (guard) return guard;
    const segNodes = docRef.current.nodes.filter((n) => n.segmentId === segmentId);
    if (calcBusy) {
      pushToast("warn", "重算未完成，不能放行");
      return { ok: false, reason: "重算中" };
    }
    const bad = segNodes.filter((n) => n.avail !== "available");
    if (segNodes.length === 0 || bad.length > 0) {
      pushToast("error", `段落内 ${bad.length} 个节点未通过安全核算，不能放行`);
      return { ok: false, reason: "存在不可用节点" };
    }
    commit(
      {
        ...docRef.current,
        approvals: {
          ...docRef.current.approvals,
          [segmentId]: { status: "approved", at: Date.now(), by: "safety" },
        },
      },
      new Set(),
    );
    const name = docRef.current.segments.find((s) => s.id === segmentId)?.name;
    logEvent("ok", `安全员放行段落「${name}」，段落已锁定`);
    pushToast("ok", `段落「${name}」已放行锁定`);
    return { ok: true };
  };

  const revokeSegment: StoreValue["revokeSegment"] = (segmentId) => {
    const guard = requireRole("safety", "撤销放行");
    if (guard) return guard;
    commit(
      {
        ...docRef.current,
        approvals: { ...docRef.current.approvals, [segmentId]: { status: "pending" } },
      },
      new Set(),
    );
    const name = docRef.current.segments.find((s) => s.id === segmentId)?.name;
    logEvent("warn", `安全员撤销段落「${name}」的放行，段落解锁`);
    pushToast("ok", `段落「${name}」已解锁，可以改点位`);
    return { ok: true };
  };

  const publish: StoreValue["publish"] = () => {
    const guard = requireRole("safety", "发布脚本");
    if (guard) return guard;
    if (calc.phase !== "idle") {
      pushToast("error", "重算未完成，发布停住");
      return { ok: false, reason: "重算中" };
    }
    if (docRef.current.nodes.some((n) => n.avail !== "available")) {
      pushToast("error", "存在安全不通过节点，不能发布");
      return { ok: false, reason: "存在不可用节点" };
    }
    const unlocked = docRef.current.segments.filter(
      (s) => docRef.current.approvals[s.id]?.status !== "approved",
    );
    if (unlocked.length > 0) {
      pushToast("error", "还有段落未经放行锁定，不能发布");
      return { ok: false, reason: "段落未全部锁定" };
    }

    const outcome = publishAtomic(docRef.current);
    if (outcome.ok && outcome.pkg) {
      setLastPublish(outcome.pkg);
      setEvents(loadEvents());
      pushToast("ok", `发布成功：${outcome.pkg.packageId}`);
      return { ok: true, pkg: outcome.pkg };
    }
    const restored = loadPublished();
    setLastPublish(restored?.pkg ?? null);
    setEvents(loadEvents());
    pushToast(
      "error",
      `写入失败，未把半成品当作已发布；已恢复到上次完整版本 ${
        outcome.restoredPkg?.packageId ?? "（无）"
      }`,
    );
    return {
      ok: false,
      reason: outcome.error,
      restoredPkg: outcome.restoredPkg,
    };
  };

  const armFailure = () => {
    armFailNextWrite();
    logEvent("warn", "已注入故障：下一次发布会在阶段包写入后中断（用于验证恢复）");
    pushToast("warn", "故障已布防：下一次发布将写入失败");
  };

  const dismissConflict = (id: string) =>
    setConflicts((c) => c.filter((x) => x.id !== id));
  const dismissToast = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));

  const value: StoreValue = {
    doc,
    role,
    setRole,
    calc,
    conflicts,
    events,
    toasts,
    dismissToast,
    lastPublish,
    selectedNodeId,
    setSelectedNodeId,
    selectedSegmentId,
    setSelectedSegmentId,
    calcCtx,
    calcBusy,
    blocked,
    previewReady,
    publishReady,
    nodesBySegment,
    updateNode,
    addNode,
    addSegment,
    simulateConcurrentEdit,
    movePosition,
    setWind,
    approveSegment,
    revokeSegment,
    publish,
    armFailure,
    dismissConflict,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
