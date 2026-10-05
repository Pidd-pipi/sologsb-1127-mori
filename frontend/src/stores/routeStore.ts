import { create } from 'zustand';
import { db } from '../db';
import type { AccessPoint } from '../types/point';
import type { PointSnapshot, RoutePointState, RouteSegment, RouteVerdict } from '../types/route';
import { makeId, toPlain } from '../utils/format';
import { judgeSegment, buildVerdict } from '../utils/routeCheck';
import { diffSnapshots, revisionOfRoute, RouteConflictError, snapshotPoints } from '../utils/routeVersion';
import { segmentLength } from '../utils/geo';

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

interface RouteState {
  segments: RouteSegment[];
  loaded: boolean;
  loading: boolean;
  error: string;
  draftName: string;
  chain: string[];
  draftSegments: DraftSegment[];
  verdict: RouteVerdict | null;
  /** 草稿基于的点位核验快照（串联路段时捕获），保存时用于乐观并发校验 */
  baseSnapshots: Record<string, PointSnapshot>;
  /** 草稿基于的路线版本（同名已保存路线的 revision，无则为 0） */
  baseRevision: number;
  load: () => Promise<void>;
  setDraftName: (name: string) => void;
  setChain: (ids: string[]) => void;
  toggleChainPoint: (id: string) => void;
  buildChainSegments: (points: AccessPoint[], snapshots: Record<string, PointSnapshot>) => void;
  updateDraftSegment: (key: string, patch: Partial<DraftSegment>) => void;
  removeDraftSegment: (key: string) => void;
  computeVerdict: (pointStates: RoutePointState[]) => RouteVerdict;
  saveRoute: () => Promise<number>;
  /** 复核重算：按当前点位核验刷新快照并标记已复核，路线恢复可发布 */
  reviewRoute: (routeName: string) => Promise<void>;
  /** 点位核验或路线版本过期时，把草稿基准同步到最新（保留草稿内容） */
  refreshBase: (snapshots: Record<string, PointSnapshot>) => Promise<void>;
  resetDraft: () => void;
}

function newKey(): string {
  return `seg-${Math.random().toString(36).slice(2, 9)}`;
}

function sortSegments(rows: RouteSegment[]): RouteSegment[] {
  return rows.sort((a, b) =>
    a.routeName === b.routeName ? a.order - b.order : a.routeName.localeCompare(b.routeName),
  );
}

export const useRouteStore = create<RouteState>((set, get) => ({
  segments: [],
  loaded: false,
  loading: false,
  error: '',
  draftName: '无障碍通行路线',
  chain: [],
  draftSegments: [],
  verdict: null,
  baseSnapshots: {},
  baseRevision: 0,

  load: async () => {
    set({ loading: true, error: '' });
    try {
      const rows = await db.routes.toArray();
      set({ segments: sortSegments(rows), loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setDraftName: (name) =>
    set((s) => ({ draftName: name, baseRevision: revisionOfRoute(s.segments, name) })),

  setChain: (ids) => set({ chain: ids, verdict: null }),

  toggleChainPoint: (id) => {
    const chain = get().chain;
    set({
      chain: chain.includes(id) ? chain.filter((x) => x !== id) : [...chain, id],
      verdict: null,
    });
  },

  /** 选好起终点与途经点后自动串联路段，同时捕获点位核验快照作为保存基准 */
  buildChainSegments: (points, snapshots) => {
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
    set((s) => ({
      draftSegments,
      verdict: null,
      baseSnapshots: snapshots,
      baseRevision: revisionOfRoute(s.segments, s.draftName),
    }));
  },

  updateDraftSegment: (key, patch) =>
    set((s) => ({
      draftSegments: s.draftSegments.map((seg) => (seg.key === key ? { ...seg, ...patch } : seg)),
      verdict: null,
    })),

  removeDraftSegment: (key) =>
    set((s) => ({
      draftSegments: s.draftSegments
        .filter((seg) => seg.key !== key)
        .map((seg, i) => ({ ...seg, order: i + 1 })),
      verdict: null,
    })),

  computeVerdict: (pointStates) => {
    const { draftSegments, draftName } = get();
    const verdict = buildVerdict(draftName, draftSegments, pointStates);
    set({ verdict });
    return verdict;
  },

  /**
   * 保存路线（同名整体替换）。乐观并发控制：
   * - 沿途点位核验版本与草稿基准不一致 → 拒绝并抛出 RouteConflictError（含变化点位与字段）；
   * - 同名路线版本与草稿基准不一致（其他页签已保存）→ 同样拒绝；
   * 只有基于最新核验与最新路线版本的一方才能写入。
   */
  saveRoute: async () => {
    const { draftSegments, draftName, baseSnapshots, baseRevision } = get();
    if (!draftSegments.length) return 0;
    const name = draftName.trim() || '未命名路线';
    const pointIds = [...new Set(draftSegments.flatMap((s) => [s.fromPointId, s.toPointId]))];
    let written = 0;
    await db.transaction('rw', db.routes, db.points, db.inspections, db.rectifies, async () => {
      const [points, inspections, rectifies, existing] = await Promise.all([
        db.points.toArray(),
        db.inspections.toArray(),
        db.rectifies.toArray(),
        db.routes.where('routeName').equals(name).toArray(),
      ]);
      const currentSnapshots = snapshotPoints(points, inspections, rectifies, pointIds);
      const changes = diffSnapshots(baseSnapshots, currentSnapshots);
      const currentRevision = revisionOfRoute(existing, name);
      const revisionConflict = currentRevision !== baseRevision;
      if (changes.length || revisionConflict) {
        throw new RouteConflictError({ changes, revisionConflict, baseRevision, currentRevision });
      }
      const nextRevision = currentRevision + 1;
      const rows: RouteSegment[] = draftSegments.map((seg) =>
        toPlain({
          id: makeId('rts'),
          routeName: name,
          fromPointId: seg.fromPointId,
          toPointId: seg.toPointId,
          length: seg.length,
          obstacleCount: seg.obstacleCount,
          stepCount: seg.stepCount,
          curbHeight: seg.curbHeight,
          wheelchairPassable: judgeSegment(seg).passable,
          order: seg.order,
          revision: nextRevision,
          reviewStatus: '已复核' as const,
          pointSnapshots: currentSnapshots,
          createdAt: new Date().toISOString(),
        }),
      );
      await db.routes.bulkDelete(existing.map((s) => s.id));
      await db.routes.bulkPut(rows);
      written = rows.length;
    });
    const all = await db.routes.toArray();
    set({ segments: sortSegments(all) });
    return written;
  },

  reviewRoute: async (routeName) => {
    await db.transaction('rw', db.routes, db.points, db.inspections, db.rectifies, async () => {
      const segs = await db.routes.where('routeName').equals(routeName).toArray();
      if (!segs.length) return;
      const pointIds = [...new Set(segs.flatMap((s) => [s.fromPointId, s.toPointId]))];
      const [points, inspections, rectifies] = await Promise.all([
        db.points.toArray(),
        db.inspections.toArray(),
        db.rectifies.toArray(),
      ]);
      const pointSnapshots = snapshotPoints(points, inspections, rectifies, pointIds);
      const nextRevision = revisionOfRoute(segs, routeName) + 1;
      for (const seg of segs) {
        await db.routes.update(seg.id, {
          pointSnapshots,
          reviewStatus: '已复核',
          revision: nextRevision,
        });
      }
    });
    const all = await db.routes.toArray();
    set({ segments: sortSegments(all) });
  },

  refreshBase: async (snapshots) => {
    // 重新读取路线表，确保基准版本包含其他页签刚保存的结果
    const all = await db.routes.toArray();
    set((s) => ({
      segments: sortSegments(all),
      baseSnapshots: snapshots,
      baseRevision: revisionOfRoute(all, s.draftName),
      verdict: null,
    }));
  },

  resetDraft: () =>
    set({ draftSegments: [], verdict: null, chain: [], baseSnapshots: {}, baseRevision: 0 }),
}));
