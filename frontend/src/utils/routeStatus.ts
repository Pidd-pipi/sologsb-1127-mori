import type { AccessPoint } from '../types/point';
import type {
  PointVerifySnapshot,
  RouteDef,
  RouteSegment,
  RouteStatus,
  RouteVerdict,
  VerifyFieldChange,
} from '../types/route';
import { buildVerdict } from './routeCheck';
import { diffSnapshots, isBaselineStale, type PointVerifyState } from './pointVerify';

/** 冻结在路线定义上的判定反序列化 */
export function parseStoredVerdict(def: RouteDef): RouteVerdict | null {
  if (!def.storedVerdict) return null;
  try {
    return JSON.parse(def.storedVerdict) as RouteVerdict;
  } catch {
    return null;
  }
}

/** 一条路线的实时视图：冻结判定 + 按最新核验重算的判定 */
export interface LiveRoute {
  def: RouteDef;
  segments: RouteSegment[];
  /** 实时状态：待复核（旧路线升级后）> 失效（核验版本变化）> 有效 */
  liveStatus: RouteStatus;
  /** 按最新核验版本重算的判定 */
  liveVerdict: RouteVerdict;
  /** 保存 / 升级时冻结的原判定 */
  storedVerdict: RouteVerdict | null;
  /** 绑定快照相对当前核验版本的字段变化 */
  changes: VerifyFieldChange[];
  /** 仅「有效 + 重算可通行」的路线可发布 */
  publishable: boolean;
  stale: boolean;
}

export function deriveRoute(
  def: RouteDef,
  segments: RouteSegment[],
  pointStates: Map<string, PointVerifyState>,
  pointMap?: Map<string, AccessPoint>,
): LiveRoute {
  const nameOf = (id: string) => pointMap?.get(id)?.name ?? id;
  const stale = isBaselineStale(def.pointSnapshots, pointStates);
  const liveStatus: RouteStatus =
    def.status === '待复核' ? '待复核' : stale ? '失效' : '有效';
  const liveVerdict = buildVerdict(def.name, segments, pointStates, nameOf);
  const changes = diffSnapshots(def.pointSnapshots, pointStates, pointMap);
  return {
    def,
    segments,
    liveStatus,
    liveVerdict,
    storedVerdict: parseStoredVerdict(def),
    changes,
    publishable: liveStatus === '有效' && liveVerdict.passable,
    stale,
  };
}

/** 编辑草稿当前绑定的核验基线（串联路段时捕获，衔接点位去重） */
export function snapshotsOfChain(
  chain: string[],
  pointStates: Map<string, PointVerifyState>,
): PointVerifySnapshot[] {
  const seen = new Set<string>();
  return chain
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .filter((id) => pointStates.has(id))
    .map((id) => ({ ...pointStates.get(id)! }));
}
