import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  NodeIndexOutlined,
  SaveOutlined,
  ThunderboltOutlined,
  AuditOutlined,
} from '@ant-design/icons';
import StatusBadge from '../components/common/StatusBadge';
import EmptyState from '../components/common/EmptyState';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';
import type { RouteSegment } from '../types/route';
import { buildVerdict, judgeSegment, CURB_FAIL, CURB_PASS } from '../utils/routeCheck';
import { buildVerifyStates, diffSnapshots } from '../utils/pointVerify';
import { deriveRoute, type LiveRoute } from '../utils/routeStatus';

export default function Routes() {
  const { message } = App.useApp();
  const points = usePointStore((s) => s.points);
  const inspections = usePointStore((s) => s.inspections);
  const rectifies = usePointStore((s) => s.rectifies);
  const pointsLoaded = usePointStore((s) => s.loaded);
  const {
    routeDefs,
    segments,
    load,
    loaded,
    draftName,
    chain,
    draftSegments,
    editingRouteId,
    baseline,
    conflict,
    setDraftName,
    setChain,
    buildChainSegments,
    updateDraftSegment,
    removeDraftSegment,
    saveRoute,
    rebaseDraft,
    startReview,
    resetDraft,
  } = useRouteStore();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const pointOptions = useMemo(
    () => points.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
    [points],
  );
  const pointMap = useMemo(() => new Map(points.map((p) => [p.id, p])), [points]);
  const nameOf = (id: string) => points.find((p) => p.id === id)?.name ?? id;

  /** 当前全部点位的最新核验状态（核验 / 复检一变，本页即时派生） */
  const pointStates = useMemo(
    () => buildVerifyStates(points.map((p) => p.id), inspections, rectifies),
    [points, inspections, rectifies],
  );

  /** 路线库实时视图：状态与判定均按最新核验版本重算 */
  const liveRoutes = useMemo<LiveRoute[]>(() => {
    const segsByRoute = new Map<string, RouteSegment[]>();
    for (const s of segments) {
      const list = segsByRoute.get(s.routeId) ?? [];
      list.push(s);
      segsByRoute.set(s.routeId, list);
    }
    return routeDefs.map((def) =>
      deriveRoute(def, segsByRoute.get(def.id) ?? [], pointStates, pointMap),
    );
  }, [routeDefs, segments, pointStates, pointMap]);

  const publishableCount = liveRoutes.filter((r) => r.publishable).length;

  /** 草稿实时判定：始终按最新核验版本重算（点位补录核验 / 复检变化立即反映） */
  const draftVerdict = useMemo(() => {
    if (!draftSegments.length) return null;
    return buildVerdict(draftName || '未命名路线', draftSegments, pointStates, nameOf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSegments, draftName, pointStates, points]);

  /** 草稿绑定基线是否已被新核验版本抛在后面 */
  const baselineStale = useMemo(
    () => (baseline.length ? baseline.some((s) => pointStates.get(s.pointId)?.revision !== s.revision) : false),
    [baseline, pointStates],
  );
  const baselineChanges = useMemo(() => {
    if (!baselineStale) return [];
    return diffSnapshots(baseline, pointStates, pointMap);
  }, [baselineStale, baseline, pointStates, pointMap]);

  const editingDef = editingRouteId ? routeDefs.find((d) => d.id === editingRouteId) ?? null : null;

  const handleBuild = () => {
    if (chain.length < 2) {
      message.warning('请至少选择起点与终点两个点位');
      return;
    }
    buildChainSegments(points);
    message.success(`已自动串联 ${chain.length - 1} 段路段，并绑定当前点位核验版本`);
  };

  const handleSave = async () => {
    if (!draftSegments.length) {
      message.warning('请先串联路段');
      return;
    }
    if (baselineStale) {
      message.warning('沿途点位核验已更新，请先「按最新核验对齐草稿」后再保存');
      return;
    }
    setSaving(true);
    try {
      const outcome = await saveRoute();
      if (outcome.accepted) {
        message.success(`路线已按最新核验版本保存（${outcome.count} 段）`);
        resetDraft();
      } else if (outcome.conflict.changes.length) {
        message.error('保存被拒绝：另一个页签已基于更新的核验版本保存同一路线，草稿已保留');
      }
    } catch (e) {
      message.error(`路线保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReview = (routeId: string) => {
    if (startReview(routeId)) {
      message.success('已载入复核编辑，原判定保留在下方路线库中可查');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      message.error('未能载入该路线');
    }
  };

  const draftColumns: ColumnsType<(typeof draftSegments)[number]> = [
    { title: '段序', dataIndex: 'order', width: 60 },
    { title: '起点', dataIndex: 'fromPointId', render: (v: string) => nameOf(v) },
    { title: '终点', dataIndex: 'toPointId', render: (v: string) => nameOf(v) },
    {
      title: '长度(m)',
      dataIndex: 'length',
      width: 110,
      render: (v: number, row) => (
        <InputNumber
          aria-label={`长度-${row.order}`}
          min={1}
          max={100000}
          value={v}
          onChange={(nv) => updateDraftSegment(row.key, { length: Number(nv ?? 0) })}
          style={{ width: 100 }}
        />
      ),
    },
    {
      title: '沿途障碍数',
      dataIndex: 'obstacleCount',
      width: 120,
      render: (v: number, row) => (
        <InputNumber
          aria-label={`障碍数-${row.order}`}
          min={0}
          max={50}
          value={v}
          onChange={(nv) => updateDraftSegment(row.key, { obstacleCount: Number(nv ?? 0) })}
          style={{ width: 100 }}
        />
      ),
    },
    {
      title: '台阶数',
      dataIndex: 'stepCount',
      width: 110,
      render: (v: number, row) => (
        <InputNumber
          aria-label={`台阶数-${row.order}`}
          min={0}
          max={50}
          value={v}
          onChange={(nv) => updateDraftSegment(row.key, { stepCount: Number(nv ?? 0) })}
          style={{ width: 100 }}
        />
      ),
    },
    {
      title: '路缘高差(cm)',
      dataIndex: 'curbHeight',
      width: 130,
      render: (v: number, row) => (
        <InputNumber
          aria-label={`路缘高差-${row.order}`}
          min={0}
          max={60}
          step={0.5}
          value={v}
          onChange={(nv) => updateDraftSegment(row.key, { curbHeight: Number(nv ?? 0) })}
          style={{ width: 110 }}
        />
      ),
    },
    {
      title: '段判定',
      width: 110,
      render: (_, row) => (
        <StatusBadge value={judgeSegment(row).passable ? '可通行' : '不可通行'} kind="route" />
      ),
    },
    {
      title: '操作',
      width: 80,
      render: (_, row) => (
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => removeDraftSegment(row.key)}
          data-testid={`remove-segment-${row.order}`}
        />
      ),
    },
  ];

  const changeColumns: ColumnsType<(typeof baselineChanges)[number]> = [
    { title: '点位', dataIndex: 'pointName', width: 200 },
    { title: '变化字段', dataIndex: 'field', width: 110 },
    { title: '保存基线', dataIndex: 'before', render: (v: string) => <Tag>{v}</Tag> },
    { title: '当前核验', dataIndex: 'after', render: (v: string) => <Tag color="processing">{v}</Tag> },
  ];

  const renderVerdictPanel = (
    v: NonNullable<typeof draftVerdict>,
    testId = 'verdict-card',
  ) => (
    <Card title="全线判定（按最新核验版本实时重算）" size="small" data-testid={testId}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <StatusBadge value={v.passable ? '可通行' : '不可通行'} kind="route" bordered />
          <Typography.Text strong data-testid="verdict-name">
            {v.routeName}
          </Typography.Text>
        </Space>
        <Row gutter={12}>
          <Col span={12}>
            <Statistic title="全线长度" value={v.totalLength} suffix="m" />
          </Col>
          <Col span={12}>
            <Statistic title="沿途障碍" value={v.totalObstacles} suffix="处" />
          </Col>
          <Col span={12}>
            <Statistic title="台阶总数" value={v.totalSteps} suffix="级" />
          </Col>
          <Col span={12}>
            <Statistic title="最大路缘高差" value={v.maxCurbHeight} suffix="cm" />
          </Col>
        </Row>
        {v.passable ? (
          <Alert type="success" showIcon message="路段与沿途点位核验均满足轮椅通行条件" />
        ) : (
          <Alert
            type="warning"
            showIcon
            message="存在不可通行项（路段字段或点位核验）"
            description={
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {v.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />
        )}
        {v.warnings.length > 0 && (
          <Alert
            type="info"
            showIcon
            message="沿途点位存在需复核的风险（不阻断通行）"
            description={
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {v.warnings.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />
        )}
        <Typography.Text type="secondary" className="gb-muted">
          判定口径：路缘高差 ≤ {CURB_PASS}cm 可通行、&gt; {CURB_FAIL}cm 不可通行，存在台阶即需绕行；
          沿途点位最新核验不合格或整改复检复发直接阻断，限期整改 / 待整改列为风险。
        </Typography.Text>
      </Space>
    </Card>
  );

  const routeColumns: ColumnsType<LiveRoute> = [
    {
      title: '路线名称',
      dataIndex: ['def', 'name'],
      render: (_: string, row) => (
        <Space size={6} wrap>
          <Typography.Text strong>{row.def.name}</Typography.Text>
          {row.def.legacy && <Tag>旧路线</Tag>}
        </Space>
      ),
    },
    {
      title: '实时状态',
      width: 110,
      render: (_, row) => (
        <span data-testid={`route-status-${row.def.id}`}>
          <StatusBadge value={row.liveStatus} kind="route" />
        </span>
      ),
    },
    {
      title: '最新核验重算',
      width: 140,
      render: (_, row) => (
        <StatusBadge
          value={row.liveVerdict.passable ? '可通行' : '不可通行'}
          kind="route"
        />
      ),
    },
    {
      title: '冻结原判定',
      width: 120,
      render: (_, row) =>
        row.storedVerdict ? (
          <StatusBadge
            value={row.storedVerdict.passable ? '可通行' : '不可通行'}
            kind="route"
          />
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: '可否发布',
      width: 110,
      render: (_, row) =>
        row.publishable ? <Tag color="success">可发布</Tag> : <Tag>不可发布</Tag>,
    },
    { title: '长度', width: 90, render: (_, row) => <Tag>{row.liveVerdict.totalLength} m</Tag> },
    {
      title: '版本变化',
      width: 90,
      render: (_, row) =>
        row.changes.length ? <Tag color="error">{row.changes.length} 项</Tag> : <Tag>0 项</Tag>,
    },
    {
      title: '操作',
      width: 120,
      render: (_, row) => (
        <Button
          size="small"
          type="primary"
          ghost
          icon={<AuditOutlined />}
          onClick={() => handleReview(row.def.id)}
          data-testid={`review-route-${row.def.id}`}
        >
          {row.liveStatus === '待复核' ? '复核' : '重新编制'}
        </Button>
      ),
    },
  ];

  const expandedRoute = (row: LiveRoute) => {
    const segCols: ColumnsType<RouteSegment> = [
      { title: '段序', dataIndex: 'order', width: 60 },
      { title: '起点', dataIndex: 'fromPointId', render: (v: string) => nameOf(v) },
      { title: '终点', dataIndex: 'toPointId', render: (v: string) => nameOf(v) },
      { title: '长度(m)', dataIndex: 'length', width: 100 },
      { title: '障碍数', dataIndex: 'obstacleCount', width: 90 },
      { title: '台阶数', dataIndex: 'stepCount', width: 90 },
      { title: '路缘高差(cm)', dataIndex: 'curbHeight', width: 120 },
      {
        title: '段字段判定',
        dataIndex: 'wheelchairPassable',
        width: 110,
        render: (v: boolean) => <StatusBadge value={v ? '可通行' : '不可通行'} kind="route" />,
      },
    ];
    return (
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {row.liveStatus === '待复核' && (
          <Alert
            type="warning"
            showIcon
            message="旧口径路线，复核完成前不可发布"
            description="该路线升级前仅按路段自填字段判定，原判定已冻结备查。请在上方按最新点位核验版本复核并保存后，才会重新成为可发布路线。"
          />
        )}
        {row.liveStatus === '失效' && (
          <Alert
            type="error"
            showIcon
            message="沿途点位核验版本已变化，路线已失效"
            description="下方为按最新核验重算的结论；完成复核保存前，该路线不得发布。"
          />
        )}
        {row.changes.length > 0 && (
          <Table
            rowKey={(r) => `${r.pointId}-${r.field}`}
            size="small"
            pagination={false}
            dataSource={row.changes}
            columns={changeColumns}
            data-testid={`route-changes-${row.def.id}`}
          />
        )}
        {row.liveVerdict.reasons.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message="重算不可通行原因"
            description={
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {row.liveVerdict.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />
        )}
        {row.liveVerdict.warnings.length > 0 && (
          <Alert
            type="info"
            showIcon
            message="重算风险提示"
            description={
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {row.liveVerdict.warnings.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />
        )}
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={row.segments}
          columns={segCols}
        />
      </Space>
    );
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">通行路线编制</h1>
          <Typography.Text type="secondary">
            路线绑定沿途点位的核验版本：点位补录核验或整改复检后，相关路线立即失效并按最新核验重算；
            两个页签同时保存时仅接受基于最新核验的一方。
          </Typography.Text>
        </div>
      </div>

      {editingDef && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            editingDef.status === '待复核'
              ? `正在复核旧路线「${editingDef.name}」：原判定保留在下方路线库中，复核保存前该路线不可发布`
              : `正在重新编制路线「${editingDef.name}」：保存后按最新核验版本冻结新判定`
          }
          action={
            <Button size="small" onClick={resetDraft}>
              退出复核
            </Button>
          }
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title={editingDef ? '路线复核编制' : '路线编制'} size="small">
            <Form layout="vertical">
              <Row gutter={12}>
                <Col xs={24} md={10}>
                  <Form.Item label="路线名称">
                    <Input
                      id="routeName"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="如 东单—王府井轮椅通道"
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={14}>
                  <Form.Item label="按顺序选择点位（起点 → 途经 → 终点）">
                    <Select
                      id="chain"
                      mode="multiple"
                      value={chain}
                      onChange={(v) => setChain(v)}
                      options={pointOptions}
                      placeholder="先选起点，再依次选择终点"
                      style={{ width: '100%' }}
                      maxTagCount={3}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Space wrap>
                <Button
                  type="primary"
                  icon={<NodeIndexOutlined />}
                  onClick={handleBuild}
                  data-testid="build-route"
                >
                  自动串联路段
                </Button>
                <Button
                  icon={<ThunderboltOutlined />}
                  onClick={() => {
                    if (!draftSegments.length) {
                      message.warning('请先串联路段');
                      return;
                    }
                    if (draftVerdict?.passable) message.success('全线判定：可通行（已按最新核验版本重算）');
                    else message.warning('全线判定：不可通行，请查看阻断原因');
                  }}
                  data-testid="compute-verdict"
                >
                  输出全线判定
                </Button>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={saving}
                  onClick={handleSave}
                  data-testid="save-route"
                  danger={baselineStale}
                >
                  {editingDef ? '复核保存' : '保存路线'}
                </Button>
                <Button onClick={resetDraft} data-testid="reset-route">
                  清空编制
                </Button>
              </Space>
            </Form>

            {baselineStale && (
              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                showIcon
                data-testid="draft-baseline-stale"
                message="编辑期间沿途点位核验已更新，保存将被拒绝"
                description={
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Table
                      size="small"
                      pagination={false}
                      rowKey={(r) => `${r.pointId}-${r.field}`}
                      dataSource={baselineChanges}
                      columns={changeColumns}
                    />
                    <Button size="small" type="primary" ghost onClick={rebaseDraft}>
                      按最新核验对齐草稿（保留路段填写）
                    </Button>
                  </Space>
                }
              />
            )}

            {conflict && (
              <Alert
                style={{ marginTop: 12 }}
                type="error"
                showIcon
                data-testid="save-conflict"
                message={`路线「${conflict.routeName}」保存被拒绝：另一个页签已基于更新的核验版本保存`}
                description={
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Typography.Text>下方草稿已原样保留，变化点位与字段如下：</Typography.Text>
                    <Table
                      size="small"
                      pagination={false}
                      rowKey={(r) => `${r.pointId}-${r.field}`}
                      dataSource={conflict.changes}
                      columns={changeColumns}
                    />
                    <Space>
                      <Button size="small" type="primary" onClick={rebaseDraft}>
                        对齐最新核验后重新保存
                      </Button>
                      <Button size="small" onClick={resetDraft}>
                        放弃草稿
                      </Button>
                    </Space>
                  </Space>
                }
              />
            )}

            <div style={{ marginTop: 16 }} data-testid="draft-segments">
              {draftSegments.length ? (
                <Table
                  rowKey="key"
                  size="small"
                  pagination={false}
                  dataSource={draftSegments}
                  columns={draftColumns}
                />
              ) : (
                <EmptyState
                  title="尚未串联路段"
                  description="选择至少两个点位后点击「自动串联路段」"
                  compact
                />
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          {draftVerdict ? (
            renderVerdictPanel(draftVerdict)
          ) : (
            <Card title="全线判定" size="small" data-testid="verdict-card">
              <EmptyState
                title="尚未输出判定"
                description="串联路段后自动按最新核验版本给出判定，也可点击「输出全线判定」"
                compact
              />
            </Card>
          )}
        </Col>
      </Row>

      <Card
        title={
          <Space wrap>
            <span>路线库（实时绑定核验版本）</span>
            <Tag color="success">可发布 {publishableCount}</Tag>
            <Tag>共 {liveRoutes.length} 条</Tag>
          </Space>
        }
        size="small"
        style={{ marginTop: 16 }}
        data-testid="route-library"
      >
        {liveRoutes.length ? (
          <Table<LiveRoute>
            rowKey={(r) => r.def.id}
            size="small"
            pagination={false}
            dataSource={liveRoutes}
            columns={routeColumns}
            expandable={{ expandedRowRender: expandedRoute, rowExpandable: () => true }}
          />
        ) : (
          <EmptyState title="暂无路线" description="编制并保存路线后在此查看" compact />
        )}
        {!pointsLoaded && (
          <Typography.Text type="secondary" className="gb-muted">
            正在载入点位核验数据…
          </Typography.Text>
        )}
      </Card>
    </div>
  );
}
