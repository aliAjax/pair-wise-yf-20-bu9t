// 燃放脚本领域模型

export type Role = "choreographer" | "pointLead" | "safety";

export interface FireworkModel {
  id: string;
  name: string;
  category: string;
  caliberMm: number;
  /** 该型号要求的最小安全距离（米） */
  requiredDistanceM: number;
  durationMs: number;
}

/** 燃放点位，坐标单位与平面图一致（米） */
export interface Position {
  id: string;
  name: string;
  x: number;
  y: number;
}

export interface Segment {
  id: string;
  name: string;
  order: number;
  note?: string;
}

export type AvailState = "unknown" | "available" | "unavailable";

export interface CueNode {
  id: string;
  label: string;
  segmentId: string;
  positionId: string;
  modelId: string;
  /** 发射仰角（度），90 为垂直朝天 */
  launchAngleDeg: number;
  /** 发射方位角（度，0=东，顺时针） */
  azimuthDeg: number;
  /** 点火时间（毫秒，相对节目起点） */
  igniteAtMs: number;
  /** 以下字段由安全重算维护 */
  avail: AvailState;
  failReasons: string[];
  /** 节点内容版本：每次编辑 +1，用于乐观锁/冲突检测/放行依据 */
  nodeVersion: number;
}

export interface Approval {
  status: "pending" | "approved";
  at?: number;
  by?: Role;
}

export interface WindState {
  /** 风吹向的方位角（度，0=东，顺时针） */
  deg: number;
  speedKmh: number;
}

export interface ScriptDoc {
  version: number;
  updatedAt: number;
  models: FireworkModel[];
  positions: Position[];
  audience: { x: number; y: number };
  segments: Segment[];
  nodes: CueNode[];
  approvals: Record<string, Approval>;
  wind: WindState;
}

export interface CalcProgress {
  phase: "idle" | "pending" | "running";
  done: number;
  total: number;
}

export interface IncomingChange {
  label?: string;
  segmentId?: string;
  positionId?: string;
  modelId?: string;
  launchAngleDeg?: number;
  azimuthDeg?: number;
  igniteAtMs?: number;
}

export interface ConflictNotice {
  id: string;
  at: number;
  nodeId: string;
  nodeLabel: string;
  detail: string;
  baseVersion: number;
  currentVersion: number;
  incoming: IncomingChange;
}

export interface PublishEvent {
  at: number;
  level: "ok" | "warn" | "error";
  message: string;
}

export interface PublishedPackage {
  packageId: string;
  docVersion: number;
  publishedAt: number;
  checksum: string;
  nodeCount: number;
  segmentCount: number;
  recovered?: boolean;
}
