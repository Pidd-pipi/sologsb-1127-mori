import Dexie, { type Table } from 'dexie';
import type { AccessPoint } from '../types/point';
import type { Inspection } from '../types/inspection';
import type { RouteDef, RouteSegment } from '../types/route';
import type { RectifyPlan } from '../types/rectify';
import { addDays, makeId, todayStr, toPlain } from '../utils/format';
import { buildVerifyStates } from '../utils/pointVerify';
import { buildVerdict, judgeInspection } from '../utils/routeCheck';

export const DB_NAME = 'gbaccessmap-db';

/**
 * 浏览器本地库：IndexedDB（Dexie）
 * v1 建 points / inspections
 * v2 加 routes 表与 pointId 索引
 * v3 加 rectifies 表，并为历史不合格核验补建整改条目
 * v4 加 routeDefs 表：路线绑定沿途点位核验版本；旧路线升级为「待复核」并冻结原判定
 */
class AccessMapDb extends Dexie {
  points!: Table<AccessPoint, string>;
  inspections!: Table<Inspection, string>;
  routes!: Table<RouteSegment, string>;
  routeDefs!: Table<RouteDef, string>;
  rectifies!: Table<RectifyPlan, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      points: 'id, code, facilityType, district, name',
      inspections: 'id, pointId, date, conclusion',
    });
    this.version(2)
      .stores({
        points: 'id, code, facilityType, district, name',
        inspections: 'id, pointId, date, conclusion',
        routes: 'id, routeName, fromPointId, toPointId, order',
      })
      .upgrade(async (tx) => {
        // v2：把 plan 阶段遗留的 routeName 缺失记录补上默认名称
        const table = tx.table('routes');
        const rows: RouteSegment[] = await table.toArray();
        for (const row of rows) {
          if (!row.routeName) {
            await table.update(row.id, { routeName: '未命名路线' });
          }
        }
      });
    this.version(3)
      .stores({
        points: 'id, code, facilityType, district, name',
        inspections: 'id, pointId, date, conclusion',
        routes: 'id, routeName, fromPointId, toPointId, order',
        rectifies: 'id, pointId, status, deadline',
      })
      .upgrade(async (tx) => {
        // v3：为历史「不合格」核验补建整改条目（已存在同点位待整改条目则跳过）
        const inspections: Inspection[] = await tx.table('inspections').toArray();
        const existed: RectifyPlan[] = await tx.table('rectifies').toArray();
        const pendingPointIds = new Set(
          existed.filter((r) => r.status !== '已整改').map((r) => r.pointId),
        );
        for (const insp of inspections) {
          if (insp.conclusion !== '不合格') continue;
          if (pendingPointIds.has(insp.pointId)) continue;
          pendingPointIds.add(insp.pointId);
          await tx.table('rectifies').add({
            id: `rct-mig-${insp.id}`,
            pointId: insp.pointId,
            requirement: `按核验结论整改：${insp.problem || '整改坡度、净宽与占用问题'}`,
            unit: '待指派责任单位',
            deadline: addDays(insp.date || todayStr(), 30),
            recheckDate: '',
            status: '待整改',
            createdAt: new Date().toISOString(),
          });
        }
      });
    this.version(4)
      .stores({
        points: 'id, code, facilityType, district, name',
        inspections: 'id, pointId, date, conclusion',
        routes: 'id, routeId, routeName, fromPointId, toPointId, order',
        routeDefs: 'id, name, status, updatedAt',
        rectifies: 'id, pointId, status, deadline',
      })
      .upgrade(async (tx) => {
        // v4：路线绑定点位核验版本。
        // 1) 为历史整改条目补 updatedAt（已复检取复检日期）；
        const rectTable = tx.table<RectifyPlan, string>('rectifies');
        const rectRows = await rectTable.toArray();
        for (const r of rectRows) {
          if (!r.updatedAt) {
            await rectTable.update(r.id, { updatedAt: r.recheckDate || '' });
          }
        }

        // 2) 每个历史路线名生成一个路线定义，状态置「待复核」，
        //    冻结升级前仅按路段字段判定的原结论，复核完成前不得发布。
        const routeTable = tx.table<RouteSegment, string>('routes');
        const defTable = tx.table<RouteDef, string>('routeDefs');
        const inspRows: Inspection[] = await tx.table('inspections').toArray();
        const allRectRows: RectifyPlan[] = await rectTable.toArray();
        const segRows: RouteSegment[] = await routeTable.toArray();
        const now = new Date().toISOString();

        const byName = new Map<string, RouteSegment[]>();
        for (const seg of segRows) {
          const name = seg.routeName || '未命名路线';
          const list = byName.get(name) ?? [];
          list.push(seg);
          byName.set(name, list);
        }
        for (const [name, list] of byName) {
          const ordered = [...list].sort((a, b) => a.order - b.order);
          const chain = ordered.length
            ? [ordered[0].fromPointId, ...ordered.map((s) => s.toPointId)]
            : [];
          const states = buildVerifyStates(chain, inspRows, allRectRows);
          // 衔接点位可能重复（如往返路线），快照按点位去重
          const seenSnap = new Set<string>();
          const snapshots = chain
            .filter((id) => !seenSnap.has(id) && seenSnap.add(id))
            .map((id) => toPlain(states.get(id)!));
          // 冻结的是旧口径原判定：只看路段自填字段，不叠加点位核验
          const originalVerdict = buildVerdict(name, ordered);
          const routeId = `rtd-legacy-${makeId('x')}`;
          const def: RouteDef = {
            id: routeId,
            name,
            chain,
            pointSnapshots: snapshots,
            status: '待复核',
            storedVerdict: JSON.stringify(originalVerdict),
            legacy: true,
            createdAt: ordered[0]?.createdAt ?? now,
            updatedAt: now,
          };
          await defTable.add(def);
          for (const seg of ordered) {
            await routeTable.update(seg.id, { routeId, routeName: name });
          }
        }
      });
  }
}

export const db = new AccessMapDb();

const SEED_POINTS: Omit<AccessPoint, 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'pt-1001',
    code: 'WZ-2024-001',
    name: '东单北大街缘石坡道',
    facilityType: '缘石坡道',
    lng: 116.4183,
    lat: 39.9142,
    district: '东城区',
    location: '东单北大街与灯市口大街交叉口东南角',
    builtYear: 2016,
    maintainUnit: '市政道路养护一所',
  },
  {
    id: 'pt-1002',
    code: 'WZ-2024-002',
    name: '王府井步行街盲道',
    facilityType: '盲道',
    lng: 116.4109,
    lat: 39.915,
    district: '东城区',
    location: '王府井大街南段 118 号门前',
    builtYear: 2018,
    maintainUnit: '市政道路养护二所',
  },
  {
    id: 'pt-1003',
    code: 'WZ-2024-003',
    name: '西直门站无障碍电梯',
    facilityType: '无障碍电梯',
    lng: 116.3555,
    lat: 39.9405,
    district: '西城区',
    location: '地铁西直门站 A 口地面层',
    builtYear: 2019,
    maintainUnit: '轨道交通运营部',
  },
  {
    id: 'pt-1004',
    code: 'WZ-2024-004',
    name: '朝阳公园南门轮椅坡道',
    facilityType: '轮椅坡道',
    lng: 116.4741,
    lat: 39.9339,
    district: '朝阳区',
    location: '朝阳公园南路南门西侧',
    builtYear: 2015,
    maintainUnit: '园林绿化服务中心',
  },
  {
    id: 'pt-1005',
    code: 'WZ-2024-005',
    name: '中关村广场无障碍卫生间',
    facilityType: '无障碍卫生间',
    lng: 116.3106,
    lat: 39.9842,
    district: '海淀区',
    location: '中关村大街 27 号地下二层',
    builtYear: 2020,
    maintainUnit: '城管委设施科',
  },
  {
    id: 'pt-1006',
    code: 'WZ-2024-006',
    name: '丰台科技园低位服务台',
    facilityType: '低位服务台',
    lng: 116.2956,
    lat: 39.856,
    district: '丰台区',
    location: '丰台科技园政务大厅一层',
    builtYear: 2021,
    maintainUnit: '城管委设施科',
  },
  {
    id: 'pt-1007',
    code: 'WZ-2024-007',
    name: '莲花池东路盲道',
    facilityType: '盲道',
    lng: 116.32,
    lat: 39.8977,
    district: '丰台区',
    location: '莲花池东路北侧辅路人行道',
    builtYear: 2014,
    maintainUnit: '市政道路养护一所',
  },
  {
    id: 'pt-1008',
    code: 'WZ-2024-008',
    name: '鲁谷路无障碍电梯',
    facilityType: '无障碍电梯',
    lng: 116.2213,
    lat: 39.9065,
    district: '石景山区',
    location: '鲁谷路 35 号院 3 号楼东侧',
    builtYear: 2013,
    maintainUnit: '轨道交通运营部',
  },
];

interface SeedInspection {
  pointId: string;
  date: string;
  inspector: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: Inspection['occupied'];
  problem: string;
}

const SEED_INSPECTIONS: SeedInspection[] = [
  {
    pointId: 'pt-1001',
    date: '2025-03-12',
    inspector: '督导员 李维',
    slope: 3.2,
    clearWidth: 150,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1002',
    date: '2025-03-14',
    inspector: '督导员 王岚',
    slope: 2.1,
    clearWidth: 130,
    hasHandrail: false,
    tactileContinuous: false,
    occupied: '无',
    problem: '盲道在路口处断开约 4 米，未设置提示盲道',
  },
  {
    pointId: 'pt-1003',
    date: '2025-04-02',
    inspector: '督导员 陈默',
    slope: 1.4,
    clearWidth: 160,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1004',
    date: '2025-04-08',
    inspector: '督导员 李维',
    slope: 6.4,
    clearWidth: 105,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '临时占用',
    problem: '坡道中段被共享单车临时占用，实际净宽不足',
  },
  {
    pointId: 'pt-1005',
    date: '2025-04-19',
    inspector: '督导员 赵敏',
    slope: 1.1,
    clearWidth: 155,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1006',
    date: '2025-05-06',
    inspector: '督导员 赵敏',
    slope: 2.6,
    clearWidth: 140,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
  {
    pointId: 'pt-1007',
    date: '2025-05-11',
    inspector: '督导员 王岚',
    slope: 9.5,
    clearWidth: 82,
    hasHandrail: false,
    tactileContinuous: false,
    occupied: '长期占用',
    problem: '盲道被沿街商铺货架长期占用，坡度过大且净宽不足 90cm',
  },
  {
    pointId: 'pt-1008',
    date: '2025-05-20',
    inspector: '督导员 陈默',
    slope: 1.8,
    clearWidth: 145,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  },
];

interface SeedRoute {
  routeId: string;
  routeName: string;
  pointIds: string[];
  length: number;
  obstacleCount: number;
  stepCount: number;
  curbHeight: number;
  /** true 表示升级口径前的旧路线：冻结原判定、待复核、不可发布 */
  legacy?: boolean;
}

const SEED_ROUTES: SeedRoute[] = [
  {
    routeId: 'rtd-seed-1',
    routeName: '东单—王府井轮椅通道',
    pointIds: ['pt-1001', 'pt-1002'],
    length: 640.5,
    obstacleCount: 1,
    stepCount: 0,
    curbHeight: 2,
  },
  {
    routeId: 'rtd-seed-2',
    routeName: '西直门—中关村无障碍接驳线',
    pointIds: ['pt-1003', 'pt-1005'],
    length: 1520,
    obstacleCount: 0,
    stepCount: 0,
    curbHeight: 2,
  },
  {
    // 旧口径路线：途经 pt-1007（核验不合格且待整改），路段字段却显示可通行
    routeId: 'rtd-seed-3',
    routeName: '莲花池东路旧轮椅通道',
    pointIds: ['pt-1007', 'pt-1008'],
    length: 480,
    obstacleCount: 1,
    stepCount: 0,
    curbHeight: 2,
    legacy: true,
  },
];

function buildSeed() {
  const now = new Date().toISOString();
  const today = todayStr();
  const points: AccessPoint[] = SEED_POINTS.map((p) => ({ ...p, createdAt: now, updatedAt: now }));
  const inspections: Inspection[] = SEED_INSPECTIONS.map((s, i) => {
    const judged = judgeInspection({
      slope: s.slope,
      clearWidth: s.clearWidth,
      hasHandrail: s.hasHandrail,
      tactileContinuous: s.tactileContinuous,
      occupied: s.occupied,
    });
    return {
      id: `ins-seed-${i + 1}`,
      pointId: s.pointId,
      date: s.date,
      inspector: s.inspector,
      slope: s.slope,
      clearWidth: s.clearWidth,
      hasHandrail: s.hasHandrail,
      tactileContinuous: s.tactileContinuous,
      occupied: s.occupied,
      conclusion: judged.conclusion,
      problem: s.problem,
      createdAt: now,
    };
  });
  const stateByPoint = buildVerifyStates(
    SEED_POINTS.map((p) => p.id),
    inspections,
    [], // 整改条目在下方构建，快照只绑定核验版本；首装演示路线状态由前端实时派生
  );
  const routes: RouteSegment[] = [];
  const routeDefs: RouteDef[] = [];
  SEED_ROUTES.forEach((r, ri) => {
    for (let i = 1; i < r.pointIds.length; i += 1) {
      routes.push({
        id: `rts-seed-${ri + 1}-${i}`,
        routeId: r.routeId,
        routeName: r.routeName,
        fromPointId: r.pointIds[i - 1],
        toPointId: r.pointIds[i],
        length: Math.round((r.length / (r.pointIds.length - 1)) * 10) / 10,
        obstacleCount: r.obstacleCount,
        stepCount: r.stepCount,
        curbHeight: r.curbHeight,
        wheelchairPassable: r.stepCount === 0 && r.curbHeight <= 3 && r.obstacleCount <= 2,
        order: i,
        createdAt: now,
      });
    }
    const ownSegments = routes.filter((x) => x.routeId === r.routeId);
    const snapshots = r.pointIds.map((id) => toPlain(stateByPoint.get(id)!));
    // 旧路线冻结旧口径原判定，新路线按绑定核验版本的完整口径判定
    const verdict = buildVerdict(
      r.routeName,
      ownSegments,
      r.legacy ? undefined : stateByPoint,
      (id) => SEED_POINTS.find((p) => p.id === id)?.name ?? id,
    );
    routeDefs.push({
      id: r.routeId,
      name: r.routeName,
      chain: [...r.pointIds],
      pointSnapshots: snapshots,
      status: r.legacy ? '待复核' : '有效',
      storedVerdict: JSON.stringify(verdict),
      legacy: Boolean(r.legacy),
      createdAt: now,
      updatedAt: now,
    });
  });
  const rectifies: RectifyPlan[] = [
    {
      id: 'rct-seed-1',
      pointId: 'pt-1007',
      requirement: '清退盲道上的商铺货架，重做坡道并加装扶手，复测净宽不低于 120cm',
      unit: '市政道路养护一所',
      deadline: addDays(today, -21),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
      updatedAt: '',
    },
    {
      id: 'rct-seed-2',
      pointId: 'pt-1002',
      requirement: '补齐路口断开的盲道并增设提示盲道',
      unit: '市政道路养护二所',
      deadline: addDays(today, -6),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
      updatedAt: '',
    },
    {
      id: 'rct-seed-3',
      pointId: 'pt-1004',
      requirement: '划设共享单车禁停区，恢复坡道净宽至 120cm 以上',
      unit: '园林绿化服务中心',
      deadline: addDays(today, 18),
      recheckDate: '',
      status: '待整改',
      createdAt: now,
      updatedAt: '',
    },
    {
      id: 'rct-seed-4',
      pointId: 'pt-1008',
      requirement: '更换电梯轿厢呼叫按钮盲文标识',
      unit: '轨道交通运营部',
      deadline: addDays(today, -40),
      recheckDate: addDays(today, -12),
      status: '已整改',
      createdAt: now,
      updatedAt: addDays(today, -12),
    },
  ];
  // 首装时重新用含整改条目的数据生成一次新路线快照（含待整改版本绑定）
  const fullStates = buildVerifyStates(
    SEED_POINTS.map((p) => p.id),
    inspections,
    rectifies,
  );
  for (const def of routeDefs) {
    if (def.legacy) continue;
    def.pointSnapshots = def.chain.map((id) => toPlain(fullStates.get(id)!));
  }
  return { points, inspections, routes, routeDefs, rectifies };
}

/** 首次打开时写入示例数据；已有数据则跳过 */
export async function ensureSeed(): Promise<void> {
  const count = await db.points.count();
  if (count > 0) return;
  const seed = toPlain(buildSeed());
  await db.transaction(
    'rw',
    db.points,
    db.inspections,
    db.routes,
    db.routeDefs,
    db.rectifies,
    async () => {
      await db.points.bulkPut(seed.points);
      await db.inspections.bulkPut(seed.inspections);
      await db.routes.bulkPut(seed.routes);
      await db.routeDefs.bulkPut(seed.routeDefs);
      await db.rectifies.bulkPut(seed.rectifies);
    },
  );
}

export { makeId };
