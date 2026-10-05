import type { Inspection } from '../types/inspection';
import type { AccessPoint } from '../types/point';
import type { RectifyPlan } from '../types/rectify';
import type {
  PointSnapshot,
  RectifySnapshot,
  RoutePointState,
  RouteSegment,
} from '../types/route';

/** 单个点位的字段变化 */
export interface PointFieldChange {
  label: string;
  before: string;
  after: string;
}

/** 单个点位的核验变化（含字段级前后值） */
export interface PointChange {
  pointId: string;
  name: string;
  fields: PointFieldChange[];
}

/**
 * 路线保存冲突：草稿基于的核验版本或路线版本已过期。
 * 携带变化点位与字段明细，页面据此提示并保留草稿。
 */
export class RouteConflictError extends Error {
  /** 点位核验变化明细（点位核验版本不一致时非空） */
  changes: PointChange[];
  /** 路线版本冲突：其他页签已保存了同一路线的新版本 */
  revisionConflict: boolean;
  baseRevision: number;
  currentRevision: number;

  constructor(init: {
    changes: PointChange[];
    revisionConflict: boolean;
    baseRevision: number;
    currentRevision: number;
  }) {
    const parts: string[] = [];
    if (init.changes.length) {
      parts.push(`沿途 ${init.changes.length} 个点位的核验已更新`);
    }
    if (init.revisionConflict) {
      parts.push(`该路线已被保存为新版本（v${init.currentRevision}）`);
    }
    super(`保存被拒绝：${parts.join('；')}。草稿已保留，请按最新核验重算后再保存。`);
    this.name = 'RouteConflictError';
    this.changes = init.changes;
    this.revisionConflict = init.revisionConflict;
    this.baseRevision = init.baseRevision;
    this.currentRevision = init.currentRevision;
  }
}

/** 点位最新一条核验（按日期，其次按创建时间） */
export function latestInspectionOf(pointId: string, inspections: Inspection[]): Inspection | null {
  let latest: Inspection | null = null;
  for (const insp of inspections) {
    if (insp.pointId !== pointId) continue;
    if (!latest || insp.date > latest.date ||
        (insp.date === latest.date && insp.createdAt > latest.createdAt)) {
      latest = insp;
    }
  }
  return latest;
}

/** 点位当前整改状态：复发 > 待整改 > 无（已整改不计） */
export function rectifyStateOf(pointId: string, rectifies: RectifyPlan[]): RectifySnapshot {
  let state: RectifySnapshot = '无';
  for (const r of rectifies) {
    if (r.pointId !== pointId) continue;
    if (r.status === '复发') return '复发';
    if (r.status === '待整改') state = '待整改';
  }
  return state;
}

/** 生成单个点位的核验快照 */
export function snapshotPoint(
  point: AccessPoint,
  inspections: Inspection[],
  rectifies: RectifyPlan[],
): PointSnapshot {
  const latest = latestInspectionOf(point.id, inspections);
  return {
    version: point.inspectionVersion ?? 0,
    name: point.name,
    conclusion: latest ? latest.conclusion : '未核验',
    slope: latest ? latest.slope : 0,
    clearWidth: latest ? latest.clearWidth : 0,
    hasHandrail: latest ? latest.hasHandrail : false,
    tactileContinuous: latest ? latest.tactileContinuous : false,
    occupied: latest ? latest.occupied : '',
    rectify: rectifyStateOf(point.id, rectifies),
  };
}

/** 批量生成点位核验快照；ids 为空时覆盖全部点位 */
export function snapshotPoints(
  points: AccessPoint[],
  inspections: Inspection[],
  rectifies: RectifyPlan[],
  ids?: string[],
): Record<string, PointSnapshot> {
  const wanted = ids ? new Set(ids) : null;
  const result: Record<string, PointSnapshot> = {};
  for (const p of points) {
    if (wanted && !wanted.has(p.id)) continue;
    result[p.id] = snapshotPoint(p, inspections, rectifies);
  }
  return result;
}

function fmtBool(v: boolean, yes: string, no: string): string {
  return v ? yes : no;
}

/** 对比两份点位快照，列出变化点位与字段（用于冲突提示与失效说明） */
export function diffSnapshots(
  base: Record<string, PointSnapshot>,
  current: Record<string, PointSnapshot>,
): PointChange[] {
  const changes: PointChange[] = [];
  const ids = new Set([...Object.keys(base), ...Object.keys(current)]);
  for (const pointId of ids) {
    const b = base[pointId];
    const c = current[pointId];
    if (!b || !c) {
      // 点位新增或移除（当前版本不支持删除点位，防御性处理）
      changes.push({
        pointId,
        name: (c ?? b)?.name ?? pointId,
        fields: [
          {
            label: '点位',
            before: b ? '在路线中' : '不在路线中',
            after: c ? '在路线中' : '不在路线中',
          },
        ],
      });
      continue;
    }
    const fields: PointFieldChange[] = [];
    if (b.version !== c.version) {
      fields.push({ label: '核验版本', before: `v${b.version}`, after: `v${c.version}` });
    }
    if (b.conclusion !== c.conclusion) {
      fields.push({ label: '结论', before: b.conclusion, after: c.conclusion });
    }
    if (b.slope !== c.slope) {
      fields.push({ label: '坡度', before: `${b.slope}%`, after: `${c.slope}%` });
    }
    if (b.clearWidth !== c.clearWidth) {
      fields.push({ label: '净宽', before: `${b.clearWidth}cm`, after: `${c.clearWidth}cm` });
    }
    if (b.hasHandrail !== c.hasHandrail) {
      fields.push({
        label: '扶手',
        before: fmtBool(b.hasHandrail, '有', '无'),
        after: fmtBool(c.hasHandrail, '有', '无'),
      });
    }
    if (b.tactileContinuous !== c.tactileContinuous) {
      fields.push({
        label: '盲道连续性',
        before: fmtBool(b.tactileContinuous, '连续', '断续'),
        after: fmtBool(c.tactileContinuous, '连续', '断续'),
      });
    }
    if (b.occupied !== c.occupied) {
      fields.push({ label: '占用情况', before: b.occupied || '—', after: c.occupied || '—' });
    }
    if (b.rectify !== c.rectify) {
      fields.push({ label: '整改状态', before: b.rectify, after: c.rectify });
    }
    if (fields.length) changes.push({ pointId, name: c.name, fields });
  }
  return changes;
}

/** 由快照还原判定用点位状态（用于查看路线保存时的原判定） */
export function statesFromSnapshots(
  snapshots: Record<string, PointSnapshot>,
): RoutePointState[] {
  return Object.entries(snapshots).map(([pointId, s]) => ({
    pointId,
    name: s.name,
    conclusion: s.conclusion,
    rectify: s.rectify,
  }));
}

/** 由当前数据计算判定用点位状态 */
export function pointStatesFromData(
  points: AccessPoint[],
  inspections: Inspection[],
  rectifies: RectifyPlan[],
  ids: string[],
): RoutePointState[] {
  const byId = new Map(points.map((p) => [p.id, p]));
  return ids.map((id) => {
    const p = byId.get(id);
    if (!p) return { pointId: id, name: id, conclusion: '未核验', rectify: '无' };
    const latest = latestInspectionOf(id, inspections);
    return {
      pointId: id,
      name: p.name,
      conclusion: latest ? latest.conclusion : '未核验',
      rectify: rectifyStateOf(id, rectifies),
    };
  });
}

/** 路线有效状态：可发布 / 待复核 / 已失效 */
export type RouteEffectiveStatus = '可发布' | '待复核' | '已失效';

export interface RouteEvaluation {
  status: RouteEffectiveStatus;
  /** 可发布：已复核且沿途点位核验与保存时一致 */
  publishable: boolean;
  /** 相对保存时快照的点位变化（已失效时非空） */
  changes: PointChange[];
}

/**
 * 评估已保存路线的有效状态：
 * - 复核状态为「待复核」（如历史数据迁移而来）→ 待复核；
 * - 沿途点位核验快照与当前不一致 → 已失效，需复核重算；
 * - 否则可发布。
 */
export function evaluateRoute(
  segments: Pick<RouteSegment, 'reviewStatus' | 'pointSnapshots'>[],
  currentSnapshots: Record<string, PointSnapshot>,
): RouteEvaluation {
  const base = segments[0]?.pointSnapshots ?? {};
  const stored = segments[0]?.reviewStatus ?? '待复核';
  const changes = diffSnapshots(base, currentSnapshots);
  if (stored === '待复核') {
    return { status: '待复核', publishable: false, changes };
  }
  if (changes.length) {
    return { status: '已失效', publishable: false, changes };
  }
  return { status: '可发布', publishable: true, changes: [] };
}

/** 取一条路线当前的版本号（无记录时为 0） */
export function revisionOfRoute(
  segments: Pick<RouteSegment, 'routeName' | 'revision'>[],
  routeName: string,
): number {
  let rev = 0;
  for (const s of segments) {
    if (s.routeName === routeName && (s.revision ?? 0) > rev) rev = s.revision;
  }
  return rev;
}
