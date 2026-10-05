import type { InspectionConclusion, OccupiedLevel } from './inspection';

/** 通行路线段 */
export interface RouteSegment {
  id: string;
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
  /** 是否可轮椅通行（由逐段核验判定） */
  wheelchairPassable: boolean;
  /** 在整条路线中的顺序，从 1 开始 */
  order: number;
  /** 路线版本：每次保存/复核 +1，用于多页签乐观并发控制 */
  revision: number;
  /** 复核状态：待复核的路线不作为可发布路线 */
  reviewStatus: RouteReviewStatus;
  /** 保存/复核时沿途点位的核验快照，用于检测点位核验变化 */
  pointSnapshots: Record<string, PointSnapshot>;
  createdAt: string;
}

export type RouteSegmentDraft = Omit<
  RouteSegment,
  'id' | 'createdAt' | 'wheelchairPassable' | 'revision' | 'reviewStatus' | 'pointSnapshots'
>;

/** 复核状态 */
export type RouteReviewStatus = '待复核' | '已复核';

/** 点位整改状态快照值 */
export type RectifySnapshot = '无' | '待整改' | '复发';

/**
 * 点位核验快照：路线保存/复核时记录沿途点位的核验版本与关键字段，
 * 之后点位核验或整改状态一变即可按字段对比出差异。
 */
export interface PointSnapshot {
  /** 点位核验版本号（与 AccessPoint.inspectionVersion 对应） */
  version: number;
  /** 点位名称（冗余存储，点位被删改时仍可展示） */
  name: string;
  conclusion: InspectionConclusion | '未核验';
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel | '';
  rectify: RectifySnapshot;
}

/** 全线判定结果 */
export interface RouteVerdict {
  routeName: string;
  passable: boolean;
  totalLength: number;
  totalObstacles: number;
  totalSteps: number;
  maxCurbHeight: number;
  /** 阻断性原因（路段障碍 + 点位不合格/复发） */
  reasons: string[];
  /** 非阻断提示（点位限期整改、待整改、未核验等） */
  warnings: string[];
}

/** 参与全线判定的沿途点位状态 */
export interface RoutePointState {
  pointId: string;
  name: string;
  conclusion: InspectionConclusion | '未核验';
  /** 整改状态：复发阻断通行，待整改仅提示 */
  rectify: RectifySnapshot;
}
