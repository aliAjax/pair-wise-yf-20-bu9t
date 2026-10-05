import type {
  CueNode,
  FireworkModel,
  Position,
  ScriptDoc,
  WindState,
} from "./types";

// ---------- 安全计算 ----------

export interface CalcContext {
  positions: Record<string, Position>;
  models: Record<string, FireworkModel>;
  audience: { x: number; y: number };
  wind: WindState;
}

export interface CalcResult {
  avail: boolean;
  reasons: string[];
  /** 调试/展示用：到观众距离、有效安全距离 */
  geometry: { pointDistanceM: number; effectiveClearanceM: number };
}

const TAU = Math.PI * 2;
const deg2rad = (d: number) => (d * Math.PI) / 180;
const normDeg = (d: number) => ((d % 360) + 360) % 360;

function distance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  return Math.hypot(ax - bx, ay - by);
}

/**
 * 有效安全余量：
 * 斜射时落弹点会沿发射方位偏移（仰角越低偏移越大，封顶 0.55*安全距离）；
 * 顺风把落弹点再吹向该方位（强风封顶 18%），逆风则缩短偏移。
 * 落弹点越逼近观众区，有效余量越小。
 */
export function evaluateNode(node: CueNode, ctx: CalcContext): CalcResult {
  const reasons: string[] = [];
  const position = ctx.positions[node.positionId];
  const model = ctx.models[node.modelId];

  if (!position) {
    return {
      avail: false,
      reasons: ["点位不存在"],
      geometry: { pointDistanceM: 0, effectiveClearanceM: 0 },
    };
  }
  if (!model) {
    return {
      avail: false,
      reasons: ["型号未绑定"],
      geometry: { pointDistanceM: 0, effectiveClearanceM: 0 },
    };
  }

  const pointDistanceM = distance(
    position.x,
    position.y,
    ctx.audience.x,
    ctx.audience.y,
  );

  // 落弹点相对点位的投影方位 = 发射方位
  const launchRad = deg2rad(normDeg(node.azimuthDeg));
  const tilt = Math.max(0, 90 - normDeg(node.launchAngleDeg)); // 0 垂直 … 90 平射
  const tiltFactor = Math.min(0.55, (tilt / 90) * 0.55);

  const windRad = deg2rad(normDeg(ctx.wind.deg));
  const dirX = Math.cos(launchRad);
  const dirY = Math.sin(launchRad);
  const windX = Math.cos(windRad);
  const windY = Math.sin(windRad);
  const windAlong = windX * dirX + windY * dirY; // 1 全顺风 / -1 全逆风
  const windFactor = Math.max(-0.1, Math.min(0.18, (windAlong * ctx.wind.speedKmh) / 80));

  const fallShift = model.requiredDistanceM * (tiltFactor + windFactor);
  const fallX = position.x + dirX * fallShift;
  const fallY = position.y + dirY * fallShift;
  const effectiveClearanceM = distance(
    fallX,
    fallY,
    ctx.audience.x,
    ctx.audience.y,
  );

  if (effectiveClearanceM < model.requiredDistanceM) {
    reasons.push(
      `有效安全余量 ${effectiveClearanceM.toFixed(0)}m < 型号要求 ${model.requiredDistanceM}m`,
    );
  }
  if (pointDistanceM < model.requiredDistanceM * 0.6) {
    reasons.push(
      `点位距观众区 ${pointDistanceM.toFixed(0)}m，低于型号间距下限 ${Math.ceil(model.requiredDistanceM * 0.6)}m`,
    );
  }

  return {
    avail: reasons.length === 0,
    reasons,
    geometry: { pointDistanceM, effectiveClearanceM },
  };
}

/** 节点的安全输入签名：点位坐标/型号参数/角度/风向任一变化都会改变 */
export function nodeSignature(node: CueNode, ctx: CalcContext): string {
  const position = ctx.positions[node.positionId];
  return JSON.stringify({
    p: position ? [position.x, position.y] : null,
    m: node.modelId,
    a: node.launchAngleDeg,
    z: node.azimuthDeg,
    w: [ctx.wind.deg, ctx.wind.speedKmh],
  });
}

// ---------- 时间格式化 ----------

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

export function parseTime(text: string): number | null {
  const m = /^(\d+):([0-5]?\d)(?:[.:](\d{1,3}))?$/.exec(text.trim());
  if (!m) return null;
  const milli = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
  return Number(m[1]) * 60000 + Number(m[2]) * 1000 + milli;
}

// ---------- 初始数据 ----------

export function createSeedDoc(): ScriptDoc {
  const models: FireworkModel[] = [
    { id: "M1", name: "30mm 扇形架", category: "扇形架", caliberMm: 30, requiredDistanceM: 35, durationMs: 2200 },
    { id: "M2", name: "75mm 礼花弹", category: "礼花弹", caliberMm: 75, requiredDistanceM: 80, durationMs: 4800 },
    { id: "M3", name: "25mm 罗马烛光", category: "罗马烛光", caliberMm: 25, requiredDistanceM: 25, durationMs: 6000 },
    { id: "M4", name: "50mm 近景礼花束", category: "礼花弹", caliberMm: 50, requiredDistanceM: 50, durationMs: 3000 },
  ];

  const positions: Position[] = [
    { id: "PA", name: "A 点·前场左", x: 120, y: 120 },
    { id: "PB", name: "B 点·前场右", x: 430, y: 120 },
    { id: "PC", name: "C 点·中场", x: 275, y: 235 },
    { id: "PD", name: "D 点·后场", x: 275, y: 340 },
    { id: "PE", name: "E 点·近景区", x: 268, y: 432 },
  ];

  const segments = [
    { id: "S1", name: "Intro 引子", order: 0, note: "音乐起 00:08" },
    { id: "S2", name: "Chorus A 主歌", order: 1, note: "齐射节拍" },
    { id: "S3", name: "Finale 终章", order: 2, note: "近景冷焰火收尾" },
  ];

  const fresh = (n: Omit<CueNode, "avail" | "failReasons" | "nodeVersion">): CueNode => ({
    ...n,
    avail: "unknown",
    failReasons: [],
    nodeVersion: 1,
  });

  const nodes: CueNode[] = [
    fresh({ id: "N1", label: "引子·扇形架左", segmentId: "S1", positionId: "PA", modelId: "M1", launchAngleDeg: 78, azimuthDeg: 90, igniteAtMs: 12500 }),
    fresh({ id: "N2", label: "引子·扇形架右", segmentId: "S1", positionId: "PB", modelId: "M1", launchAngleDeg: 78, azimuthDeg: 90, igniteAtMs: 12500 }),
    fresh({ id: "N3", label: "主歌·礼花弹左", segmentId: "S2", positionId: "PA", modelId: "M2", launchAngleDeg: 88, azimuthDeg: 135, igniteAtMs: 68200 }),
    fresh({ id: "N4", label: "主歌·礼花弹右", segmentId: "S2", positionId: "PB", modelId: "M2", launchAngleDeg: 88, azimuthDeg: 45, igniteAtMs: 68200 }),
    fresh({ id: "N5", label: "主歌·中场烛光", segmentId: "S2", positionId: "PC", modelId: "M3", launchAngleDeg: 90, azimuthDeg: 0, igniteAtMs: 74000 }),
    fresh({ id: "N6", label: "终章·后场礼花", segmentId: "S3", positionId: "PD", modelId: "M2", launchAngleDeg: 90, azimuthDeg: 0, igniteAtMs: 222000 }),
    // E 点贴近观众区且型号要求 50m，默认即不可用——演示安全拦截
    fresh({ id: "N7", label: "终章·近景礼花束", segmentId: "S3", positionId: "PE", modelId: "M4", launchAngleDeg: 90, azimuthDeg: 180, igniteAtMs: 230000 }),
  ];

  return {
    version: 1,
    updatedAt: Date.now(),
    models,
    positions,
    audience: { x: 275, y: 475 },
    segments,
    nodes,
    approvals: { S1: { status: "pending" }, S2: { status: "pending" }, S3: { status: "pending" } },
    wind: { deg: 180, speedKmh: 8 },
  };
}
