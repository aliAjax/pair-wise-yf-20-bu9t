import type {
  DocState,
  FireworkModel,
  IgnitionNode,
  NodeStatus,
  Point,
  Segment,
  Wind,
} from "./types";

export const WIND_DIRS: Wind[] = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** 风向（吹去方向）-> 屏幕坐标向量，y 向下为正 */
export function windVector(w: Wind): { x: number; y: number } {
  const map: Record<Wind, [number, number]> = {
    N: [0, -1],
    NE: [0.7071, -0.7071],
    E: [1, 0],
    SE: [0.7071, 0.7071],
    S: [0, 1],
    SW: [-0.7071, 0.7071],
    W: [-1, 0],
    NW: [-0.7071, -0.7071],
  };
  return { x: map[w][0], y: map[w][1] };
}

/** 观众区起始 y（平面图百分比），观众区位于图下方 */
export const AUDIENCE_TOP = 82;
/** 平面图 100% 边长对应的实地距离 m */
export const MAP_METERS = 200;

/** 点位到观众区的最近距离 m */
export function distanceToAudienceMeters(p: Point): number {
  if (p.y >= AUDIENCE_TOP) return 0;
  return ((AUDIENCE_TOP - p.y) / 100) * MAP_METERS;
}

export interface RecomputeResult {
  status: NodeStatus;
  effectiveSafety: number;
  blockedReason?: string;
}

/**
 * 节点安全距离重算：
 * - 下风向（风朝观众区吹）时安全距离放大 1.6 倍
 * - 发射方位朝向观众区（下方锥区）时，距离不足即受限
 * - 其余情况距离不足也受限
 */
export function recomputeNode(
  node: IgnitionNode,
  point: Point,
  model: FireworkModel,
  wind: Wind,
): RecomputeResult {
  const wv = windVector(wind);
  const downwind = Math.max(0, wv.y); // 风吹向观众区方向的分量
  const effective = Math.round(model.safetyDistance * (1 + 0.6 * downwind));
  const dist = distanceToAudienceMeters(point);

  const rad = (node.angle * Math.PI) / 180;
  // 方位角 0=北（图上方）顺时针，屏幕向量 (sin, -cos)
  const trajY = -Math.cos(rad);
  const towardAudience = trajY > 0.34; // 约 70° 朝向锥

  if (dist < effective) {
    if (towardAudience) {
      return {
        status: "blocked",
        effectiveSafety: effective,
        blockedReason: "发射朝向观众区且安全距离不足",
      };
    }
    if (downwind > 0.34) {
      return {
        status: "blocked",
        effectiveSafety: effective,
        blockedReason: "下风向安全距离不足",
      };
    }
    return {
      status: "blocked",
      effectiveSafety: effective,
      blockedReason: "安全距离不足",
    };
  }
  return { status: "available", effectiveSafety: effective };
}

/** 秒 -> "MM:SS.mmm" */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "00:00.000";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** "MM:SS.mmm" -> 秒 */
export function parseTime(t: string): number {
  const m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(t.trim());
  if (!m) return NaN;
  const ms = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
  return Number(m[1]) * 60 + Number(m[2]) + ms / 1000;
}

export function checksum(obj: unknown): string {
  const s = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "h" + (h >>> 0).toString(16).padStart(8, "0");
}

/** 基于内容的文档版本号：内容不变则版本不变，与编辑次数/窗口无关 */
export function contentVersion(doc: DocState): number {
  const { docRevision: _rev, ...rest } = doc;
  return parseInt(checksum(rest).slice(2), 16);
}

export interface PublishPackage {
  kind: "fireworks-script-package";
  packageVersion: number;
  publishedAt: number;
  doc: DocState;
  checksum: string;
}

export function buildPackage(doc: DocState, now: number): PublishPackage {
  const body = {
    kind: "fireworks-script-package" as const,
    packageVersion: doc.docRevision,
    publishedAt: now,
    doc,
  };
  return { ...body, checksum: checksum(body) };
}

export function verifyPackage(pkg: PublishPackage | null | undefined): pkg is PublishPackage {
  if (!pkg || pkg.kind !== "fireworks-script-package") return false;
  const { checksum: cs, ...rest } = pkg;
  return checksum(rest) === cs;
}

export function nodeLabel(doc: DocState, node: IgnitionNode | undefined): string {
  if (!node) return "未知节点";
  const seg = doc.segments.find((s) => s.id === node.segmentId);
  const idx = doc.nodes
    .filter((n) => n.segmentId === node.segmentId)
    .findIndex((n) => n.id === node.id);
  return `${seg?.name ?? "未命名段落"} · 节点${idx + 1}`;
}

export function segmentOf(doc: DocState, node: IgnitionNode): Segment | undefined {
  return doc.segments.find((s) => s.id === node.segmentId);
}

export function pointOf(doc: DocState, node: IgnitionNode): Point | undefined {
  return doc.points.find((p) => p.id === node.pointId);
}

export function modelOf(doc: DocState, node: IgnitionNode): FireworkModel | undefined {
  return doc.models.find((m) => m.id === node.modelId);
}
