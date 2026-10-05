import type { Inspection } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import type { PointVerifySnapshot, VerifyFieldChange } from '../types/route';
import type { AccessPoint } from '../types/point';

/** 实时核验状态：由最新核验 + 活跃整改条目派生 */
export interface PointVerifyState extends PointVerifySnapshot {}

/** 取日期最大（同日取创建时间最大）的核验记录 */
export function latestInspection(list: Inspection[]): Inspection | null {
  let latest: Inspection | null = null;
  for (const ins of list) {
    if (!latest) {
      latest = ins;
      continue;
    }
    if (ins.date > latest.date || (ins.date === latest.date && ins.createdAt > latest.createdAt)) {
      latest = ins;
    }
  }
  return latest;
}

/** 活跃整改条目：复发优先于待整改；已整改不参与阻断 */
export function activeRectify(list: RectifyPlan[]): RectifyPlan | null {
  let relapse: RectifyPlan | null = null;
  let pending: RectifyPlan | null = null;
  for (const r of list) {
    if (r.status === '复发') {
      if (!relapse || r.updatedAt > relapse.updatedAt || (!relapse.updatedAt && r.createdAt > relapse.createdAt)) {
        relapse = r;
      }
    } else if (r.status === '待整改') {
      if (!pending || r.deadline < pending.deadline) pending = r;
    }
  }
  return relapse ?? pending;
}

/** 核验版本指纹：核验记录 / 活跃整改任一字段变化即换版 */
export function revisionOf(latest: Inspection | null, active: RectifyPlan | null): string {
  const insp = latest ? latest.id : 'none';
  const rect = active ? `${active.id}:${active.status}:${active.updatedAt || active.createdAt}` : 'none';
  return `${insp}|${rect}`;
}

/** 由一个点位的全部核验与整改记录计算当前核验状态 */
export function buildPointState(
  pointId: string,
  inspections: Inspection[],
  rectifies: RectifyPlan[],
): PointVerifyState {
  const latest = latestInspection(inspections);
  const active = activeRectify(rectifies);
  return {
    pointId,
    inspectionId: latest ? latest.id : null,
    date: latest ? latest.date : '',
    conclusion: latest ? latest.conclusion : null,
    slope: latest ? latest.slope : null,
    clearWidth: latest ? latest.clearWidth : null,
    hasHandrail: latest ? latest.hasHandrail : null,
    tactileContinuous: latest ? latest.tactileContinuous : null,
    occupied: latest ? latest.occupied : null,
    rectifyId: active ? active.id : null,
    rectifyStatus: active ? active.status : null,
    recheckDate: active ? active.recheckDate : '',
    revision: revisionOf(latest, active),
  };
}

/** 批量计算多个点位的核验状态（同表传入，内部按 pointId 过滤） */
export function buildVerifyStates(
  pointIds: string[],
  inspections: Inspection[],
  rectifies: RectifyPlan[],
): Map<string, PointVerifyState> {
  const inspByPoint = new Map<string, Inspection[]>();
  for (const ins of inspections) {
    const list = inspByPoint.get(ins.pointId) ?? [];
    list.push(ins);
    inspByPoint.set(ins.pointId, list);
  }
  const rectByPoint = new Map<string, RectifyPlan[]>();
  for (const r of rectifies) {
    const list = rectByPoint.get(r.pointId) ?? [];
    list.push(r);
    rectByPoint.set(r.pointId, list);
  }
  const map = new Map<string, PointVerifyState>();
  for (const id of pointIds) {
    map.set(id, buildPointState(id, inspByPoint.get(id) ?? [], rectByPoint.get(id) ?? []));
  }
  return map;
}

/** 点位核验状态对轮椅通行的影响 */
export interface PointAccess {
  passable: boolean;
  reason: string | null;
  warning: string | null;
}

/**
 * 点位级通行判定：
 * - 最新结论不合格（无论整改跟踪到哪一步）：阻断；
 * - 整改复检复发：阻断；
 * - 待整改 / 限期整改：不阻断但列入风险提示；
 * - 合格 / 已整改：可通行；从未核验：提示补录。
 */
export function judgePoint(state: PointVerifyState): PointAccess {
  if (state.conclusion === '不合格') {
    return { passable: false, reason: '最新核验结论为不合格', warning: null };
  }
  if (state.rectifyStatus === '复发') {
    return { passable: false, reason: '整改复检复发，现场仍不达标', warning: null };
  }
  if (state.rectifyStatus === '待整改') {
    return { passable: true, reason: null, warning: '存在待整改条目，通行条件待复查' };
  }
  if (state.conclusion === '限期整改') {
    return { passable: true, reason: null, warning: '最新核验结论为限期整改' };
  }
  if (!state.conclusion) {
    return { passable: true, reason: null, warning: '点位尚未核验，需补录核验' };
  }
  return { passable: true, reason: null, warning: null };
}

/** 快照字段 -> 中文标签 */
const FIELD_LABELS: Record<keyof Omit<PointVerifySnapshot, 'pointId' | 'revision'>, string> = {
  inspectionId: '核验版本',
  date: '核验日期',
  conclusion: '核验结论',
  slope: '坡度',
  clearWidth: '净宽',
  hasHandrail: '扶手',
  tactileContinuous: '盲道连续性',
  occupied: '占用情况',
  rectifyId: '整改条目',
  rectifyStatus: '整改状态',
  recheckDate: '复检日期',
};

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '（无）';
  if (key === 'hasHandrail') return value ? '有' : '无';
  if (key === 'tactileContinuous') return value ? '连续' : '断续';
  if (key === 'slope') return `${value}%`;
  if (key === 'clearWidth') return `${value} cm`;
  return String(value);
}

/**
 * 比较路线保存时的快照与当前核验状态，列出发生变化的点位与字段。
 * 用于：保存冲突提示、失效路线变化明细。
 */
export function diffSnapshots(
  snapshots: PointVerifySnapshot[],
  current: Map<string, PointVerifyState>,
  pointMap?: Map<string, AccessPoint>,
): VerifyFieldChange[] {
  const changes: VerifyFieldChange[] = [];
  for (const snap of snapshots) {
    const now = current.get(snap.pointId);
    if (!now) continue;
    const pointName = pointMap?.get(snap.pointId)?.name ?? snap.pointId;
    for (const key of Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[]) {
      const before = snap[key];
      const after = now[key];
      const bothEmpty =
        (before === null || before === undefined || before === '') &&
        (after === null || after === undefined || after === '');
      if (bothEmpty || before === after) continue;
      changes.push({
        pointId: snap.pointId,
        pointName,
        field: FIELD_LABELS[key],
        before: formatValue(key, before),
        after: formatValue(key, after),
      });
    }
  }
  return changes;
}

/** 快照中任一点位 revision 与当前不一致即为过期 */
export function isBaselineStale(
  snapshots: PointVerifySnapshot[],
  current: Map<string, PointVerifyState>,
): boolean {
  return snapshots.some((s) => current.get(s.pointId)?.revision !== s.revision);
}
