import { create } from 'zustand';
import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type {
  PointVerifySnapshot,
  RouteDef,
  RouteSegment,
  VerifyFieldChange,
} from '../types/route';
import { makeId, toPlain } from '../utils/format';
import { judgeSegment, buildVerdict } from '../utils/routeCheck';
import { segmentLength } from '../utils/geo';
import { buildVerifyStates, diffSnapshots, isBaselineStale } from '../utils/pointVerify';
import { snapshotsOfChain } from '../utils/routeStatus';
import { broadcastData, onDataSignal } from '../utils/channels';
import { usePointStore } from './pointStore';

/** 编辑中的路段（尚未落库） */
export interface DraftSegment {
  key: string;
  fromPointId: string;
  toPointId: string;
  length: number;
  obstacleCount: number;
  stepCount: number;
  curbHeight: number;
  order: number;
}

/** 保存冲突：基于旧核验版本的一方保留草稿，并列出变化点位与字段 */
export interface SaveConflict {
  routeName: string;
  changes: VerifyFieldChange[];
  /** 冲突方草稿保存时绑定的旧基线 */
  baseline: PointVerifySnapshot[];
}

export type SaveRouteOutcome =
  | { accepted: true; count: number; routeId: string }
  | { accepted: false; conflict: SaveConflict };

interface RouteState {
  routeDefs: RouteDef[];
  segments: RouteSegment[];
  loaded: boolean;
  loading: boolean;
  error: string;
  draftName: string;
  chain: string[];
  draftSegments: DraftSegment[];
  /** 正在复核的路线 id；为空表示新建 */
  editingRouteId: string | null;
  /** 草稿当前绑定的沿途点位核验版本快照 */
  baseline: PointVerifySnapshot[];
  /** 最近一次保存被拒的冲突信息，保留草稿供改写后重存 */
  conflict: SaveConflict | null;
  load: () => Promise<void>;
  setDraftName: (name: string) => void;
  setChain: (ids: string[]) => void;
  toggleChainPoint: (id: string) => void;
  buildChainSegments: (points: AccessPoint[]) => void;
  updateDraftSegment: (key: string, patch: Partial<DraftSegment>) => void;
  removeDraftSegment: (key: string) => void;
  saveRoute: () => Promise<SaveRouteOutcome>;
  /** 冲突后以最新核验版本刷新基线，保留路段填写内容 */
  rebaseDraft: () => void;
  /** 载入一条既有路线进入复核编辑（不改变其待复核 / 失效状态） */
  startReview: (routeId: string) => boolean;
  resetDraft: () => void;
}

function newKey(): string {
  return `seg-${Math.random().toString(36).slice(2, 9)}`;
}

function chainOf(segments: DraftSegment[]): string[] {
  const ordered = [...segments].sort((a, b) => a.order - b.order);
  if (!ordered.length) return [];
  return [ordered[0].fromPointId, ...ordered.map((s) => s.toPointId)];
}

export const useRouteStore = create<RouteState>((set, get) => ({
  routeDefs: [],
  segments: [],
  loaded: false,
  loading: false,
  error: '',
  draftName: '无障碍通行路线',
  chain: [],
  draftSegments: [],
  editingRouteId: null,
  baseline: [],
  conflict: null,

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const [defs, rows] = await Promise.all([db.routeDefs.toArray(), db.routes.toArray()]);
      set({
        routeDefs: defs.sort((a, b) =>
          a.name === b.name ? a.createdAt.localeCompare(b.createdAt) : a.name.localeCompare(b.name),
        ),
        segments: rows.sort((a, b) =>
          a.routeId === b.routeId ? a.order - b.order : a.routeName.localeCompare(b.routeName),
        ),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setDraftName: (name) => set({ draftName: name }),

  setChain: (ids) => set({ chain: ids, conflict: null }),

  toggleChainPoint: (id) => {
    const chain = get().chain;
    set({
      chain: chain.includes(id) ? chain.filter((x) => x !== id) : [...chain, id],
      conflict: null,
    });
  },

  /** 选好起终点与途经点后自动串联路段，并捕获当前核验版本作为草稿基线 */
  buildChainSegments: (points) => {
    const chain = get().chain;
    const byId = new Map(points.map((p) => [p.id, p]));
    const ordered = chain.map((id) => byId.get(id)).filter(Boolean) as AccessPoint[];
    const draftSegments: DraftSegment[] = [];
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1];
      const to = ordered[i];
      draftSegments.push({
        key: newKey(),
        fromPointId: from.id,
        toPointId: to.id,
        length: segmentLength({ lng: from.lng, lat: from.lat }, { lng: to.lng, lat: to.lat }),
        obstacleCount: 0,
        stepCount: 0,
        curbHeight: 2,
        order: i,
      });
    }
    const { inspections, rectifies } = usePointStore.getState();
    const states = buildVerifyStates(chain, inspections, rectifies);
    set({ draftSegments, baseline: snapshotsOfChain(chain, states), conflict: null });
  },

  updateDraftSegment: (key, patch) =>
    set((s) => ({
      draftSegments: s.draftSegments.map((seg) => (seg.key === key ? { ...seg, ...patch } : seg)),
    })),

  removeDraftSegment: (key) =>
    set((s) => {
      const draftSegments = s.draftSegments
        .filter((seg) => seg.key !== key)
        .map((seg, i) => ({ ...seg, order: i + 1 }));
      const chain = chainOf(draftSegments);
      const { inspections, rectifies } = usePointStore.getState();
      const states = buildVerifyStates(chain, inspections, rectifies);
      return { draftSegments, baseline: snapshotsOfChain(chain, states) };
    }),

  /**
   * 保存路线：事务内读取权威核验数据做乐观并发校验。
   * 两个页签同时保存同一路线时，只有基于最新核验版本的一方接受落库；
   * 基线过期的一方不写入，保留草稿并带回变化点位与字段。
   */
  saveRoute: async () => {
    const state = get();
    const { draftSegments, draftName, baseline, editingRouteId } = state;
    if (!draftSegments.length) {
      return { accepted: false, conflict: { routeName: draftName || '未命名路线', changes: [], baseline: [] } };
    }
    const chain = chainOf(draftSegments);
    const now = new Date().toISOString();
    const name = draftName.trim() || '未命名路线';

    // 事务内读取 + 写入，确保并发校验与落库基于同一份库内最新数据
    const outcome = await db.transaction(
      'rw',
      db.points,
      db.inspections,
      db.rectifies,
      db.routes,
      db.routeDefs,
      async () => {
        const [points, inspections, rectifies, existingDef] = await Promise.all([
          db.points.toArray(),
          db.inspections.toArray(),
          db.rectifies.toArray(),
          editingRouteId ? db.routeDefs.get(editingRouteId) : Promise.resolve(undefined),
        ]);
        const states = buildVerifyStates(chain, inspections, rectifies);

        // 并发校验：草稿基线必须仍是最新核验版本
        if (baseline.length && isBaselineStale(baseline, states)) {
          const pointMap = new Map(points.map((p) => [p.id, p]));
          return {
            kind: 'conflict' as const,
            changes: diffSnapshots(baseline, states, pointMap),
          };
        }

        const snapshots = snapshotsOfChain(chain, states);
        const nameOf = (id: string) => points.find((p) => p.id === id)?.name ?? id;
        const verdict = buildVerdict(name, draftSegments, states, nameOf);
        const routeId = editingRouteId ?? `rtd-${makeId('x')}`;

        const rows: RouteSegment[] = draftSegments.map((seg) =>
          toPlain({
            id: makeId('rts'),
            routeId,
            routeName: name,
            fromPointId: seg.fromPointId,
            toPointId: seg.toPointId,
            length: seg.length,
            obstacleCount: seg.obstacleCount,
            stepCount: seg.stepCount,
            curbHeight: seg.curbHeight,
            wheelchairPassable: judgeSegment(seg).passable,
            order: seg.order,
            createdAt: now,
          }),
        );

        // 复核保存：路线回到有效状态，冻结重算判定，原判定不再作为发布依据
        const def: RouteDef = toPlain({
          id: routeId,
          name,
          chain,
          pointSnapshots: snapshots,
          status: '有效' as const,
          storedVerdict: JSON.stringify(verdict),
          legacy: false,
          createdAt: existingDef?.createdAt ?? now,
          updatedAt: now,
        });

        // 同一路线重存：先清掉旧段（含旧路线升级前的路段）再整体替换
        await db.routes.where('routeId').equals(routeId).delete();
        await db.routes.bulkPut(rows);
        await db.routeDefs.put(def);
        return { kind: 'saved' as const, routeId, count: rows.length };
      },
    );

    if (outcome.kind === 'conflict') {
      const conflict: SaveConflict = {
        routeName: name,
        changes: outcome.changes,
        baseline: get().baseline,
      };
      set({ conflict });
      return { accepted: false, conflict };
    }

    const [defs, rows] = await Promise.all([db.routeDefs.toArray(), db.routes.toArray()]);
    set({
      routeDefs: defs.sort((a, b) =>
        a.name === b.name ? a.createdAt.localeCompare(b.createdAt) : a.name.localeCompare(b.name),
      ),
      segments: rows.sort((a, b) =>
        a.routeId === b.routeId ? a.order - b.order : a.routeName.localeCompare(b.routeName),
      ),
      conflict: null,
    });
    broadcastData('route-saved');
    return { accepted: true, count: outcome.count, routeId: outcome.routeId };
  },

  rebaseDraft: () => {
    const { chain, draftSegments } = get();
    const ids = draftSegments.length ? chainOf(draftSegments) : chain;
    const { inspections, rectifies } = usePointStore.getState();
    const states = buildVerifyStates(ids, inspections, rectifies);
    set({ baseline: snapshotsOfChain(ids, states), conflict: null });
  },

  startReview: (routeId) => {
    const def = get().routeDefs.find((d) => d.id === routeId);
    const segs = get()
      .segments.filter((s) => s.routeId === routeId)
      .sort((a, b) => a.order - b.order);
    if (!def || !segs.length) return false;
    const draftSegments: DraftSegment[] = segs.map((s) => ({
      key: newKey(),
      fromPointId: s.fromPointId,
      toPointId: s.toPointId,
      length: s.length,
      obstacleCount: s.obstacleCount,
      stepCount: s.stepCount,
      curbHeight: s.curbHeight,
      order: s.order,
    }));
    set({
      editingRouteId: def.id,
      draftName: def.name,
      chain: [...def.chain],
      draftSegments,
      // 复核编辑基于保存时的核验快照，保存时再由事务做最终校验
      baseline: def.pointSnapshots.map((s) => ({ ...s })),
      conflict: null,
    });
    return true;
  },

  resetDraft: () =>
    set({
      draftSegments: [],
      chain: [],
      baseline: [],
      conflict: null,
      editingRouteId: null,
      draftName: '无障碍通行路线',
    }),
}));

/**
 * 跨标签页：
 * - 其它页签保存路线 -> 本页签同步路线库，避免并发基线误判；
 * - 点位核验变化已由 pointStore 监听，路线状态在页面中按最新核验实时派生。
 */
onDataSignal((signal) => {
  if (signal.kind !== 'route-saved') return;
  if (!useRouteStore.getState().loaded) return;
  void useRouteStore.getState().load();
});
