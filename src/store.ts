import { useSyncExternalStore } from "react";
import type {
  DocState,
  IgnitionNode,
  Wind,
} from "./types";
import {
  buildPackage,
  contentVersion,
  nodeLabel,
  recomputeNode,
  verifyPackage,
  type PublishPackage,
} from "./logic";

const DOC_KEY = "fw:doc:v1";
const PENDING_KEY = "fw:publish:pending";
const CURRENT_KEY = "fw:publish:current";
const BACKUP_KEY = "fw:publish:backup";
const CHANNEL = "fw-script-sync-v1";

export interface ConflictNotice {
  id: string;
  nodeId: string;
  nodeName: string;
}

export interface LogLine {
  id: string;
  at: number;
  text: string;
  kind: "info" | "ok" | "warn" | "err";
}

export interface PublishState {
  status: "idle" | "publishing" | "success" | "failed" | "recovered";
  currentVersion: number | null;
  lastPublishedAt: number | null;
  backupVersion: number | null;
  log: LogLine[];
}

export interface UiState {
  doc: DocState;
  recomputing: boolean;
  conflicts: ConflictNotice[];
  lockMsg: string | null;
  chaos: boolean;
  publish: PublishState;
}

type Patch = Partial<Pick<IgnitionNode, "pointId" | "modelId" | "angle" | "fireTime" | "duration">>;

type SyncMsg =
  | { type: "edit"; nodeId: string; baseVersion: number; version: number; patch: Patch; origin: string; msgId: string }
  | { type: "conflict"; nodeId: string; origin: string; msgId: string }
  | { type: "doc"; action: string; payload: unknown; origin: string };

interface PendingEdit {
  nodeId: string;
  values: Record<string, unknown>;
}

const clone = <T,>(v: T): T => structuredClone(v);

function seedDoc(): DocState {
  return {
    wind: "S",
    docRevision: 1,
    models: [
      { id: "m1", name: "30mm扇形架", category: "扇形架", caliber: 30, safetyDistance: 35 },
      { id: "m2", name: "75mm礼花弹", category: "礼花弹", caliber: 75, safetyDistance: 100 },
      { id: "m3", name: "冷焰火（舞台）", category: "冷焰火", caliber: 20, safetyDistance: 8 },
      { id: "m4", name: "罗马烛光8发", category: "罗马烛光", caliber: 25, safetyDistance: 20 },
    ],
    points: [
      { id: "pA", name: "A点位", x: 26, y: 46 },
      { id: "pB", name: "B点位", x: 56, y: 40 },
      { id: "pC", name: "C点位", x: 80, y: 48 },
      { id: "pD", name: "D点位", x: 40, y: 24 },
    ],
    segments: [
      { id: "s1", name: "Intro", musicTime: "00:12.500", approved: false },
      { id: "s2", name: "Chorus A", musicTime: "01:08.200", approved: false },
      { id: "s3", name: "Finale", musicTime: "03:42.000", approved: false },
    ],
    nodes: [
      { id: "n1", segmentId: "s1", pointId: "pA", modelId: "m1", angle: 0, fireTime: 12.5, duration: 30, version: 1, status: "stale", effectiveSafety: 0 },
      { id: "n2", segmentId: "s2", pointId: "pB", modelId: "m2", angle: 180, fireTime: 68.2, duration: 45, version: 1, status: "stale", effectiveSafety: 0 },
      { id: "n3", segmentId: "s3", pointId: "pC", modelId: "m2", angle: 0, fireTime: 222, duration: 60, version: 1, status: "stale", effectiveSafety: 0 },
      { id: "n4", segmentId: "s3", pointId: "pD", modelId: "m3", angle: 90, fireTime: 230, duration: 20, version: 1, status: "stale", effectiveSafety: 0 },
    ],
  };
}

function readJSON(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  localStorage.setItem(key, value);
}

class ScriptStore {
  state: UiState;
  private origin = (Math.random() * 1e9 | 0).toString(36);
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, PendingEdit>();
  private timers: number[] = [];
  private recomputeSet = new Set<string>();
  private recomputeAll = false;
  private logSeq = 0;

  constructor() {
    const doc = (readJSON(DOC_KEY) as DocState | null) ?? seedDoc();
    this.state = {
      doc,
      recomputing: false,
      conflicts: [],
      lockMsg: null,
      chaos: false,
      publish: {
        status: "idle",
        currentVersion: null,
        lastPublishedAt: null,
        backupVersion: null,
        log: [],
      },
    };
    this.initChannel();
    this.recoverIfNeeded();
    this.refreshPublishMeta();
    // 启动即重算一次，演示「重算中暂停预览/发布」
    this.scheduleRecompute("all");
  }

  // ---------- 订阅 ----------
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    try {
      writeStorage(DOC_KEY, JSON.stringify(this.state.doc));
    } catch {
      /* 存储不可用时仅内存态工作 */
    }
    this.listeners.forEach((l) => l());
  }

  /** 提交文档变更并触发节点重算 */
  private commit(recipe: (draft: DocState) => void, recompute?: "all" | string[]) {
    const draft = clone(this.state.doc);
    recipe(draft);
    draft.docRevision = contentVersion(draft);
    this.state = { ...this.state, doc: draft };
    if (recompute) this.scheduleRecompute(recompute);
    this.emit();
  }

  private post(msg: SyncMsg) {
    try {
      this.channel?.postMessage(msg);
    } catch {
      /* 协同窗口不可用时静默 */
    }
  }

  // ---------- 多窗口协同 ----------
  private initChannel() {
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (ev: MessageEvent<SyncMsg>) => {
        const msg = ev.data;
        if (msg.origin === this.origin) return;
        if (msg.type === "edit") this.handleRemoteEdit(msg);
        else if (msg.type === "conflict") this.handleConflict(msg);
        else if (msg.type === "doc") this.handleDoc(msg.action, msg.payload);
      };
    } catch {
      this.channel = null;
    }
  }

  /** 本地修改节点（乐观更新 + 版本号 + 冲突回滚） */
  editNode(nodeId: string, patch: Patch) {
    const node = this.state.doc.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const seg = this.state.doc.segments.find((s) => s.id === node.segmentId);
    const geometry =
      patch.pointId !== undefined || patch.modelId !== undefined || patch.angle !== undefined;
    if (seg?.approved && geometry) {
      this.state = {
        ...this.state,
        lockMsg: `段落《${seg.name}》已放行锁定，修改节点绑定前请先撤销放行`,
      };
      this.emit();
      return;
    }

    const baseVersion = node.version;
    const values: Record<string, unknown> = {};
    for (const k of Object.keys(patch) as (keyof Patch)[]) values[k] = node[k];
    const msgId = `${this.origin}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    this.pending.set(msgId, { nodeId, values });

    this.commit(
      (draft) => {
        const n = draft.nodes.find((x) => x.id === nodeId)!;
        Object.assign(n, patch);
        n.version += 1;
        if (geometry) n.status = "stale";
      },
      geometry ? [nodeId] : undefined,
    );
    const resultingVersion = this.state.doc.nodes.find((n) => n.id === nodeId)!.version;
    this.post({ type: "edit", nodeId, baseVersion, version: resultingVersion, patch, origin: this.origin, msgId });
  }

  /** 撤销某节点上本窗口的未决修改，返回被恢复的字段 */
  private revertPending(nodeId: string): PendingEdit | undefined {
    for (const [id, p] of this.pending) {
      if (p.nodeId === nodeId) {
        this.pending.delete(id);
        return p;
      }
    }
    return undefined;
  }

  private handleRemoteEdit(msg: Extract<SyncMsg, { type: "edit" }>) {
    const node = this.state.doc.nodes.find((n) => n.id === msg.nodeId);
    if (!node) return;
    const seg = this.state.doc.segments.find((s) => s.id === node.segmentId);
    const geometry =
      msg.patch.pointId !== undefined ||
      msg.patch.modelId !== undefined ||
      msg.patch.angle !== undefined;
    if (seg?.approved && geometry) {
      this.state = {
        ...this.state,
        lockMsg: `段落《${seg.name}》已放行锁定，已拒绝外部窗口对节点绑定的修改`,
      };
      this.emit();
      return;
    }

    if (node.version === msg.baseVersion) {
      // 基于最新版本：正常应用
      this.revertPending(msg.nodeId);
      this.commit(
        (draft) => {
          const n = draft.nodes.find((x) => x.id === msg.nodeId)!;
          Object.assign(n, msg.patch);
          n.version = msg.version;
          if (geometry) n.status = "stale";
        },
        geometry ? [msg.nodeId] : undefined,
      );
      return;
    }

    // 晚到的修改：保留原段落，拒绝并通知发起方回滚
    this.post({ type: "conflict", nodeId: msg.nodeId, origin: this.origin, msgId: msg.msgId });
  }

  /** 冲突回滚：晚到的修改保留原段落（恢复被改字段），并提示冲突 */
  private handleConflict(msg: Extract<SyncMsg, { type: "conflict" }>) {
    const p = this.pending.get(msg.msgId);
    if (!p) return;
    this.pending.delete(msg.msgId);
    const node = this.state.doc.nodes.find((n) => n.id === p.nodeId);
    this.commit((draft) => {
      const n = draft.nodes.find((x) => x.id === p.nodeId);
      if (n) Object.assign(n, p.values);
    }, [p.nodeId]);
    this.state = {
      ...this.state,
      conflicts: [
        ...this.state.conflicts,
        { id: msg.msgId, nodeId: p.nodeId, nodeName: nodeLabel(this.state.doc, node) },
      ],
    };
    this.emit();
  }

  dismissConflict(id: string) {
    this.state = { ...this.state, conflicts: this.state.conflicts.filter((c) => c.id !== id) };
    this.emit();
  }

  clearLock() {
    this.state = { ...this.state, lockMsg: null };
    this.emit();
  }

  // ---------- 点位 / 风向 ----------
  setWind(w: Wind) {
    this.commit((draft) => {
      draft.wind = w;
    }, "all");
    this.post({ type: "doc", action: "wind", payload: w, origin: this.origin });
  }

  movePoint(pointId: string, x: number, y: number) {
    const usedByApproved = this.state.doc.nodes.some((n) => {
      const seg = this.state.doc.segments.find((s) => s.id === n.segmentId);
      return seg?.approved && n.pointId === pointId;
    });
    if (usedByApproved) {
      const seg = this.state.doc.segments.find((s) =>
        this.state.doc.nodes.some((n) => n.pointId === pointId && n.segmentId === s.id),
      );
      this.state = {
        ...this.state,
        lockMsg: `点位被已放行段落《${seg?.name ?? ""}》使用，改点位前请先撤销放行`,
      };
      this.emit();
      return;
    }
    const affected = this.state.doc.nodes
      .filter((n) => n.pointId === pointId)
      .map((n) => n.id);
    this.commit(
      (draft) => {
        const p = draft.points.find((x) => x.id === pointId);
        if (p) {
          p.x = x;
          p.y = y;
        }
      },
      affected,
    );
    this.post({ type: "doc", action: "point-move", payload: { id: pointId, x, y }, origin: this.origin });
  }

  // ---------- 段落放行 ----------
  approveSegment(id: string) {
    this.commit((draft) => {
      const s = draft.segments.find((x) => x.id === id);
      if (s) s.approved = true;
    });
    this.post({ type: "doc", action: "segment-approve", payload: id, origin: this.origin });
  }

  revokeSegment(id: string) {
    this.commit((draft) => {
      const s = draft.segments.find((x) => x.id === id);
      if (s) s.approved = false;
    });
    this.post({ type: "doc", action: "segment-revoke", payload: id, origin: this.origin });
  }

  addSegment(name: string, musicTime: string) {
    const id = `s${Date.now().toString(36)}`;
    const seg = { id, name, musicTime, approved: false };
    this.commit((draft) => {
      draft.segments.push(seg);
    });
    this.post({ type: "doc", action: "segment-add", payload: seg, origin: this.origin });
  }

  // ---------- 节点 ----------
  addNode(segmentId: string) {
    const id = `n${Date.now().toString(36)}`;
    const node: IgnitionNode = {
      id,
      segmentId,
      pointId: this.state.doc.points[0]?.id ?? "",
      modelId: this.state.doc.models[0]?.id ?? "",
      angle: 0,
      fireTime: 0,
      duration: 30,
      version: 1,
      status: "stale",
      effectiveSafety: 0,
    };
    this.commit((draft) => {
      draft.nodes.push(node);
    }, [id]);
    this.post({ type: "doc", action: "node-add", payload: node, origin: this.origin });
  }

  deleteNode(nodeId: string) {
    this.commit((draft) => {
      draft.nodes = draft.nodes.filter((n) => n.id !== nodeId);
    });
    this.post({ type: "doc", action: "node-delete", payload: nodeId, origin: this.origin });
  }

  // ---------- 型号 ----------
  addModel(name: string, category: DocState["models"][number]["category"], caliber: number, safetyDistance: number) {
    const model = { id: `m${Date.now().toString(36)}`, name, category, caliber, safetyDistance };
    this.commit((draft) => {
      draft.models.push(model);
    });
    this.post({ type: "doc", action: "model-add", payload: model, origin: this.origin });
  }

  // ---------- 远端文档动作 ----------
  private handleDoc(action: string, payload: unknown) {
    switch (action) {
      case "wind":
        this.commit((d) => {
          d.wind = payload as Wind;
        }, "all");
        break;
      case "point-move": {
        const { id, x, y } = payload as { id: string; x: number; y: number };
        const affected = this.state.doc.nodes.filter((n) => n.pointId === id).map((n) => n.id);
        this.commit(
          (d) => {
            const p = d.points.find((q) => q.id === id);
            if (p) {
              p.x = x;
              p.y = y;
            }
          },
          affected,
        );
        break;
      }
      case "segment-approve":
        this.commit((d) => {
          const s = d.segments.find((q) => q.id === payload);
          if (s) s.approved = true;
        });
        break;
      case "segment-revoke":
        this.commit((d) => {
          const s = d.segments.find((q) => q.id === payload);
          if (s) s.approved = false;
        });
        break;
      case "segment-add":
        this.commit((d) => {
          d.segments.push(payload as DocState["segments"][number]);
        });
        break;
      case "node-add": {
        const node = payload as IgnitionNode;
        this.commit((d) => {
          d.nodes.push(node);
        }, [node.id]);
        break;
      }
      case "node-delete":
        this.commit((d) => {
          d.nodes = d.nodes.filter((n) => n.id !== payload);
        });
        break;
      case "model-add":
        this.commit((d) => {
          d.models.push(payload as DocState["models"][number]);
        });
        break;
    }
  }

  // ---------- 重算调度（防抖 -> 重算中 -> 完成） ----------
  private scheduleRecompute(ids: "all" | string[]) {
    if (ids === "all") this.recomputeAll = true;
    else ids.forEach((id) => this.recomputeSet.add(id));
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];

    const t1 = window.setTimeout(() => {
      // 注意：不在此处清空 recomputeAll/recomputeSet —— 等待期间若有新变化，
      // t2 会被重置，最终重算目标必须包含累积的全部节点，否则其余节点会卡在「重算中」
      const targets = this.recomputeAll ? "all" : Array.from(this.recomputeSet);

      this.state = { ...this.state, recomputing: true };
      this.commit((draft) => {
        for (const n of draft.nodes) {
          if (targets === "all" || targets.includes(n.id)) n.status = "recomputing";
        }
      });

      const t2 = window.setTimeout(() => {
        const finalTargets = this.recomputeAll ? "all" : Array.from(this.recomputeSet);
        this.recomputeAll = false;
        this.recomputeSet.clear();
        this.commit((draft) => {
          for (const n of draft.nodes) {
            if (finalTargets !== "all" && !finalTargets.includes(n.id)) continue;
            const point = draft.points.find((p) => p.id === n.pointId);
            const model = draft.models.find((m) => m.id === n.modelId);
            if (!point || !model) {
              n.status = "blocked";
              n.blockedReason = "点位或型号缺失";
              n.effectiveSafety = 0;
              continue;
            }
            const r = recomputeNode(n, point, model, draft.wind);
            n.status = r.status;
            n.effectiveSafety = r.effectiveSafety;
            n.blockedReason = r.blockedReason;
          }
        });
        this.state = { ...this.state, recomputing: false };
        this.emit();
      }, 800);
      this.timers.push(t2);
    }, 150);
    this.timers.push(t1);
  }

  // ---------- 发布：本地存储 + 备份恢复协议 ----------
  private log(text: string, kind: LogLine["kind"]): LogLine {
    return { id: `log-${++this.logSeq}`, at: Date.now(), text, kind };
  }

  toggleChaos() {
    this.state = { ...this.state, chaos: !this.state.chaos };
    this.emit();
  }

  /** 启动时清理半份写入残留，并校验当前版本完整性 */
  private recoverIfNeeded() {
    const pending = readJSON(PENDING_KEY);
    const current = readJSON(CURRENT_KEY) as PublishPackage | null;
    const backup = readJSON(BACKUP_KEY) as PublishPackage | null;
    const log: LogLine[] = [];
    let recovered = false;

    if (pending) {
      localStorage.removeItem(PENDING_KEY);
      log.push(this.log("检测到上次未完成的写入残留，已丢弃（未当作已发布版本）", "warn"));
    }
    if (!verifyPackage(current) && verifyPackage(backup)) {
      writeStorage(CURRENT_KEY, JSON.stringify(backup));
      recovered = true;
      log.push(this.log(`当前已发布版本损坏，已从上次完整版本 v${backup.packageVersion} 恢复`, "warn"));
    }
    if (log.length) {
      this.state = {
        ...this.state,
        publish: {
          ...this.state.publish,
          status: recovered ? "recovered" : this.state.publish.status,
          currentVersion: verifyPackage(backup) ? backup.packageVersion : this.state.publish.currentVersion,
          backupVersion: verifyPackage(backup) ? backup.packageVersion : this.state.publish.backupVersion,
          log,
        },
      };
    }
  }

  private refreshPublishMeta() {
    const current = readJSON(CURRENT_KEY) as PublishPackage | null;
    const backup = readJSON(BACKUP_KEY) as PublishPackage | null;
    this.state = {
      ...this.state,
      publish: {
        ...this.state.publish,
        currentVersion: verifyPackage(current) ? current.packageVersion : null,
        lastPublishedAt: verifyPackage(current) ? current.publishedAt : null,
        backupVersion: verifyPackage(backup) ? backup.packageVersion : null,
      },
    };
  }

  async publish() {
    const { doc } = this.state;
    const hasBlocked = doc.nodes.some((n) => n.status === "blocked" || n.status === "stale");
    const hasUnapproved = doc.segments.some((s) => !s.approved);
    if (this.state.recomputing || this.state.conflicts.length || hasBlocked || hasUnapproved) return;

    const prevLog = this.state.publish.log;
    this.state = {
      ...this.state,
      publish: { ...this.state.publish, status: "publishing", log: [...prevLog, this.log("开始写入发布包…", "info")] },
    };
    this.emit();

    const pkg = buildPackage(doc, Date.now());
    try {
      // 1. 先写临时位
      writeStorage(PENDING_KEY, JSON.stringify(pkg));
      // 2. 回读校验
      const readback = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null");
      if (!verifyPackage(readback)) throw new Error("回读校验失败");
      // 3. 备份上一完整版本，再原子切换
      const curRaw = localStorage.getItem(CURRENT_KEY);
      if (curRaw) writeStorage(BACKUP_KEY, curRaw);
      if (this.state.chaos) {
        // 模拟写入故障：current 被写坏（半成品）
        writeStorage(CURRENT_KEY, "{broken-package");
        throw new Error("模拟写入故障");
      }
      writeStorage(CURRENT_KEY, JSON.stringify(pkg));
      localStorage.removeItem(PENDING_KEY);

      this.state = {
        ...this.state,
        publish: {
          status: "success",
          currentVersion: pkg.packageVersion,
          lastPublishedAt: pkg.publishedAt,
          backupVersion: this.state.publish.backupVersion,
          log: [...prevLog, this.log(`发布成功，版本 v${pkg.packageVersion}`, "ok")],
        },
      };
    } catch (e) {
      // 写入失败：丢弃临时位，绝不把半份脚本当已发布；从备份恢复
      localStorage.removeItem(PENDING_KEY);
      const cur = readJSON(CURRENT_KEY) as PublishPackage | null;
      const bak = readJSON(BACKUP_KEY) as PublishPackage | null;
      const msg = e instanceof Error ? e.message : String(e);
      if (!verifyPackage(cur) && verifyPackage(bak)) {
        writeStorage(CURRENT_KEY, JSON.stringify(bak));
        this.state = {
          ...this.state,
          publish: {
            status: "recovered",
            currentVersion: bak.packageVersion,
            lastPublishedAt: bak.publishedAt,
            backupVersion: bak.packageVersion,
            log: [...prevLog, this.log(`写入失败（${msg}），已从上次完整版本 v${bak.packageVersion} 恢复`, "warn")],
          },
        };
      } else {
        this.state = {
          ...this.state,
          publish: {
            status: "failed",
            currentVersion: verifyPackage(cur) ? cur.packageVersion : null,
            lastPublishedAt: verifyPackage(cur) ? cur.publishedAt : null,
            backupVersion: verifyPackage(bak) ? bak.packageVersion : null,
            log: [...prevLog, this.log(`发布失败（${msg}），未把半成品当作已发布版本`, "err")],
          },
        };
      }
    }
    this.emit();
  }
}

export const store = new ScriptStore();

export function useStore(): UiState {
  return useSyncExternalStore(store.subscribe, () => store.state);
}
