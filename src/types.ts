// 燃放脚本核心数据模型

export type Category = "礼花弹" | "罗马烛光" | "扇形架" | "冷焰火";

/** 烟花型号：绑定口径与基础安全距离 */
export interface FireworkModel {
  id: string;
  name: string;
  category: Category;
  caliber: number; // 口径 mm
  safetyDistance: number; // 基础安全距离 m
}

/** 燃放点位（平面图坐标，百分比） */
export interface Point {
  id: string;
  name: string;
  x: number; // 0-100
  y: number; // 0-100
}

/** 风向：风吹去的方向（N 表示吹向北边/图上方） */
export type Wind = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/**
 * 节点可用状态
 * - available: 重算完成且安全距离满足
 * - stale: 点位/风向变化后旧结果已失效，等待重算
 * - recomputing: 重算进行中，整场预览与发布暂停
 * - blocked: 重算完成但安全距离不满足，禁止发布
 */
export type NodeStatus = "available" | "stale" | "recomputing" | "blocked";

/** 节目段落：安全员放行后锁定 */
export interface Segment {
  id: string;
  name: string;
  musicTime: string; // 音乐时间点 "00:12.500"
  approved: boolean; // 安全员放行
}

/** 点火节点：绑定型号、发射角度、点位 */
export interface IgnitionNode {
  id: string;
  segmentId: string;
  pointId: string;
  modelId: string;
  angle: number; // 发射方位角 0-360（0=北/图上方，顺时针）
  fireTime: number; // 点火时间 s
  duration: number; // 持续时间 s
  version: number; // 并发版本号
  status: NodeStatus;
  effectiveSafety: number; // 重算后的有效安全距离 m
  blockedReason?: string;
}

export interface DocState {
  models: FireworkModel[];
  points: Point[];
  segments: Segment[];
  nodes: IgnitionNode[];
  wind: Wind;
  docRevision: number;
}
