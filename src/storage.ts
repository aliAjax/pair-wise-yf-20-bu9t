import type { PublishedPackage, ScriptDoc } from "./types";
import { createSeedDoc } from "./domain";

// 本地存储键
const K_DOC = "fireworks.doc.v1";
const K_PUBLISHED = "fireworks.published.v1";
const K_STAGE = "fireworks.stage.v1";
const K_LOG = "fireworks.events.v1";

// 失败注入开关（演示用）：置位后下一次发布在“写阶段包”后崩溃
const K_FAIL_NEXT = "fireworks.debug.failNextWrite";

export type StoreKind = "localStorage" | "memory";

interface StagedEnvelope {
  kind: "stage";
  docVersion: number;
  payload: ScriptDoc;
  checksum: string;
  at: number;
}

interface PublishedEnvelope {
  kind: "published";
  pkg: PublishedPackage;
  payload: ScriptDoc;
  checksum: string;
}

export interface StoredEvent {
  at: number;
  level: "ok" | "warn" | "error";
  message: string;
}

// FNV-1a 校验和，用于识别“半份脚本”
export function checksum(doc: ScriptDoc): string {
  const json = JSON.stringify(doc);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

class Backend {
  kind: StoreKind = "memory";
  private mem = new Map<string, string>();

  /** 惰性解析 localStorage：首帧被限制或尚未就绪时，后续仍可自动切换到本地存储 */
  private resolveLs(): Storage | null {
    try {
      const ls = localStorage;
      const probe = "__fw_probe__";
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      this.kind = "localStorage";
      return ls;
    } catch {
      this.kind = "memory";
      return null;
    }
  }

  get(key: string): string | null {
    const ls = this.resolveLs();
    if (ls) {
      try {
        return ls.getItem(key);
      } catch {
        return this.mem.get(key) ?? null;
      }
    }
    return this.mem.get(key) ?? null;
  }

  set(key: string, value: string): void {
    const ls = this.resolveLs();
    if (ls) {
      ls.setItem(key, value);
      return;
    }
    this.mem.set(key, value);
  }

  remove(key: string): void {
    const ls = this.resolveLs();
    if (ls) ls.removeItem(key);
    this.mem.delete(key);
  }
}

export const backend = new Backend();

// ---------- 事件日志 ----------

export function loadEvents(): StoredEvent[] {
  try {
    return JSON.parse(backend.get(K_LOG) ?? "[]") as StoredEvent[];
  } catch {
    return [];
  }
}

export function appendEvent(level: StoredEvent["level"], message: string): StoredEvent[] {
  const events = loadEvents();
  events.unshift({ at: Date.now(), level, message });
  const trimmed = events.slice(0, 50);
  backend.set(K_LOG, JSON.stringify(trimmed));
  return trimmed;
}

// ---------- 工作脚本 ----------

export function loadDoc(): ScriptDoc {
  const raw = backend.get(K_DOC);
  if (!raw) {
    const seed = createSeedDoc();
    backend.set(K_DOC, JSON.stringify(seed));
    return seed;
  }
  try {
    const doc = JSON.parse(raw) as ScriptDoc;
    if (!doc.nodes || !doc.segments) throw new Error("结构缺失");
    return doc;
  } catch (e) {
    appendEvent("error", `工作脚本损坏：${(e as Error).message}，请从已发布版本恢复`);
    const seed = createSeedDoc();
    return seed;
  }
}

export function saveDoc(doc: ScriptDoc): void {
  backend.set(K_DOC, JSON.stringify(doc));
}

// ---------- 已发布版本 ----------

export function loadPublished(): PublishedEnvelope | null {
  const raw = backend.get(K_PUBLISHED);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as PublishedEnvelope;
    if (env.kind !== "published" || checksum(env.payload) !== env.checksum) {
      throw new Error("校验和不匹配");
    }
    return env;
  } catch (e) {
    appendEvent("error", `已发布包校验失败：${(e as Error).message}`);
    return null;
  }
}

export function getPublishedDoc(): ScriptDoc | null {
  return loadPublished()?.payload ?? null;
}

function seedInitialPublished(): void {
  // 首次使用时给一个“上次完整版本”作为可恢复基线
  if (backend.get(K_PUBLISHED)) return;
  const seed = createSeedDoc();
  const pkg: PublishedPackage = {
    packageId: "PKG-SEED",
    docVersion: 0,
    publishedAt: Date.now(),
    checksum: checksum(seed),
    nodeCount: seed.nodes.length,
    segmentCount: seed.segments.length,
  };
  backend.set(
    K_PUBLISHED,
    JSON.stringify({ kind: "published", pkg, payload: seed, checksum: checksum(seed) } satisfies PublishedEnvelope),
  );
}

// ---------- 失败注入 ----------

export function armFailNextWrite(): boolean {
  backend.set(K_FAIL_NEXT, "1");
  return true;
}
function consumeFailArm(): boolean {
  if (backend.get(K_FAIL_NEXT)) {
    backend.remove(K_FAIL_NEXT);
    return true;
  }
  return false;
}

// ---------- 启动自愈：上次发布会话崩溃后恢复 ----------

export interface BootResult {
  recoveredFromStage: boolean;
  stageBroken: boolean;
}

export function bootStorage(): BootResult {
  seedInitialPublished();
  let recoveredFromStage = false;
  let stageBroken = false;

  const stageRaw = backend.get(K_STAGE);
  if (stageRaw) {
    try {
      const stage = JSON.parse(stageRaw) as StagedEnvelope;
      if (stage.kind !== "stage" || checksum(stage.payload) !== stage.checksum) {
        throw new Error("阶段包校验失败");
      }
      // 存在完整阶段包但没有成为发布版 = 上次写入在提交前中断。
      // 按策略不把半成品当已发布：丢弃阶段包，继续以上一个完整版本为准。
      backend.remove(K_STAGE);
      appendEvent(
        "warn",
        `检测到未提交的完整阶段包（v${stage.docVersion}），已丢弃；现场以最近完整发布版本为准`,
      );
      recoveredFromStage = true;
    } catch (e) {
      backend.remove(K_STAGE);
      appendEvent("error", `阶段包不完整（${(e as Error).message}），已清除并回退到上次完整版本`);
      stageBroken = true;
    }
  }
  return { recoveredFromStage, stageBroken };
}

export interface PublishOutcome {
  ok: boolean;
  pkg?: PublishedPackage;
  restoredPkg?: PublishedPackage;
  error?: string;
}

/**
 * 原子发布：
 * 1) 写阶段包并回读校验；2) 提交正式包并回读校验；3) 删除阶段包。
 * 任一步失败都不允许把半成品视为已发布，并恢复到上次完整版本。
 */
export function publishAtomic(doc: ScriptDoc): PublishOutcome {
  const previous = loadPublished();
  const sum = checksum(doc);
  const stage: StagedEnvelope = {
    kind: "stage",
    docVersion: doc.version,
    payload: doc,
    checksum: sum,
    at: Date.now(),
  };

  // 步骤 1：阶段包
  try {
    backend.set(K_STAGE, JSON.stringify(stage));
    if (consumeFailArm()) {
      // 模拟“写阶段包后进程崩溃/磁盘错误”：正式键从未写入
      throw new Error("注入的写入失败：阶段包写入后中断（正式包未提交）");
    }
    const reread = backend.get(K_STAGE);
    if (!reread || JSON.parse(reread).checksum !== sum) {
      throw new Error("阶段包回读校验失败");
    }
  } catch (e) {
    backend.remove(K_STAGE);
    appendEvent("error", `发布中断在阶段写入：${(e as Error).message}`);
    return {
      ok: false,
      error: (e as Error).message,
      restoredPkg: previous?.pkg,
    };
  }

  // 步骤 2：提交正式包
  const pkg: PublishedPackage = {
    packageId: `PKG-${doc.version}-${sum.slice(0, 4)}`,
    docVersion: doc.version,
    publishedAt: Date.now(),
    checksum: sum,
    nodeCount: doc.nodes.length,
    segmentCount: doc.segments.length,
  };
  const envelope: PublishedEnvelope = { kind: "published", pkg, payload: doc, checksum: sum };
  try {
    backend.set(K_PUBLISHED, JSON.stringify(envelope));
    const verify = loadPublished();
    if (!verify || verify.pkg.packageId !== pkg.packageId) {
      throw new Error("正式包回读校验失败");
    }
  } catch (e) {
    // 正式键可能已写坏：用上一个完整版本覆盖回去
    if (previous) backend.set(K_PUBLISHED, JSON.stringify(previous));
    backend.remove(K_STAGE);
    appendEvent("error", `发布提交失败，已回滚到 ${previous?.pkg.packageId ?? "无可用版本"}：${(e as Error).message}`);
    return {
      ok: false,
      error: (e as Error).message,
      restoredPkg: previous?.pkg,
    };
  }

  // 步骤 3：清理阶段包
  backend.remove(K_STAGE);
  appendEvent("ok", `发布成功：${pkg.packageId}（${pkg.nodeCount} 个节点 / ${pkg.segmentCount} 个段落）`);
  return { ok: true, pkg };
}
