import type { InspectionConclusion, OccupiedLevel } from './inspection';
import type { RectifyStatus } from './rectify';

/** 通行路线段 */
export interface RouteSegment {
  id: string;
  /** 所属路线定义 id（v4 起） */
  routeId: string;
  /** 路线名称，同一条路线的多段共用一个名称 */
  routeName: string;
  fromPointId: string;
  toPointId: string;
  /** 长度 m */
  length: number;
  /** 沿途障碍数 */
  obstacleCount: number;
  /** 台阶数 */
  stepCount: number;
  /** 路缘高差 cm */
  curbHeight: number;
  /**
   * 段自填字段是否可通行（仅按路缘高差 / 台阶数 / 障碍数判定）。
   * 全线是否可通行以 RouteVerdict 为准，需叠加沿途点位核验版本。
   */
  wheelchairPassable: boolean;
  /** 在整条路线中的顺序，从 1 开始 */
  order: number;
  createdAt: string;
}

export type RouteSegmentDraft = Omit<RouteSegment, 'id' | 'createdAt' | 'wheelchairPassable'>;

/**
 * 路线绑定的沿途点位核验版本快照。
 * 点位核验、整改复检发生变化时 revision 改变，路线立即失效需重算。
 */
export interface PointVerifySnapshot {
  pointId: string;
  /** 最新核验记录 id，从未核验为 null */
  inspectionId: string | null;
  /** 最新核验日期 */
  date: string;
  conclusion: InspectionConclusion | null;
  slope: number | null;
  clearWidth: number | null;
  hasHandrail: boolean | null;
  tactileContinuous: boolean | null;
  occupied: OccupiedLevel | null;
  /** 活跃整改条目（待整改 / 复发）id，无则 null */
  rectifyId: string | null;
  rectifyStatus: RectifyStatus | null;
  recheckDate: string;
  /** 该点位核验版本的确定性指纹 */
  revision: string;
}

/** 路线生命周期状态 */
export type RouteStatus = '有效' | '失效' | '待复核';

/**
 * 路线定义：路线头（名称、绑定的点位核验版本、冻结的原判定）。
 * 一个定义对应 routes 表中的多段。
 */
export interface RouteDef {
  id: string;
  name: string;
  /** 按顺序串联的点位 id（起点 → 途经 → 终点） */
  chain: string[];
  /** 保存时绑定的沿途点位核验版本 */
  pointSnapshots: PointVerifySnapshot[];
  status: RouteStatus;
  /** 保存 / 复核时冻结的全线判定（JSON 序列化的 RouteVerdict） */
  storedVerdict: string | null;
  /** v4 升级而来的旧路线：冻结升级前按路段字段判定的原结论 */
  legacy: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 全线判定结果 */
export interface RouteVerdict {
  routeName: string;
  passable: boolean;
  totalLength: number;
  totalObstacles: number;
  totalSteps: number;
  maxCurbHeight: number;
  /** 阻断可通行性的原因 */
  reasons: string[];
  /** 不阻断但需复核关注的风险（限期整改 / 待整改等） */
  warnings: string[];
}

/** 点位核验版本相对保存快照的字段变化 */
export interface VerifyFieldChange {
  pointId: string;
  pointName: string;
  field: string;
  before: string;
  after: string;
}
