import { useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
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
  ReloadOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import StatusBadge from '../components/common/StatusBadge';
import EmptyState from '../components/common/EmptyState';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore, type DraftSegment } from '../stores/routeStore';
import type { RouteSegment } from '../types/route';
import { buildVerdict, judgeSegment, CURB_FAIL, CURB_PASS } from '../utils/routeCheck';
import {
  diffSnapshots,
  evaluateRoute,
  pointStatesFromData,
  revisionOfRoute,
  RouteConflictError,
  snapshotPoints,
  statesFromSnapshots,
  type PointChange,
} from '../utils/routeVersion';

/** 变化点位与字段列表（冲突弹窗与失效说明共用） */
function ChangeList({ changes }: { changes: PointChange[] }) {
  return (
    <ul style={{ margin: 0, paddingInlineStart: 18 }} data-testid="change-list">
      {changes.map((c) => (
        <li key={c.pointId} data-testid={`change-point-${c.pointId}`}>
          <Typography.Text strong>{c.name}</Typography.Text>：
          {c.fields.map((f) => `${f.label} ${f.before} → ${f.after}`).join('；')}
        </li>
      ))}
    </ul>
  );
}

export default function Routes() {
  const { message } = App.useApp();
  const points = usePointStore((s) => s.points);
  const inspections = usePointStore((s) => s.inspections);
  const rectifies = usePointStore((s) => s.rectifies);
  const {
    segments,
    draftName,
    chain,
    draftSegments,
    verdict,
    baseSnapshots,
    setDraftName,
    setChain,
    buildChainSegments,
    updateDraftSegment,
    removeDraftSegment,
    computeVerdict,
    saveRoute,
    reviewRoute,
    refreshBase,
    resetDraft,
  } = useRouteStore();
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState('');
  const [conflict, setConflict] = useState<RouteConflictError | null>(null);

  const pointOptions = useMemo(
    () => points.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
    [points],
  );
  const nameOf = (id: string) => points.find((p) => p.id === id)?.name ?? id;

  /** 草稿串联点位的当前核验快照与判定状态（随点位核验/整改变化实时更新） */
  const chainSnapshots = useMemo(
    () => snapshotPoints(points, inspections, rectifies, chain),
    [points, inspections, rectifies, chain],
  );
  const chainStates = useMemo(
    () => pointStatesFromData(points, inspections, rectifies, chain),
    [points, inspections, rectifies, chain],
  );
  /** 草稿基准与当前核验的差异：非空说明沿途点位核验在编制期间发生了变化 */
  const draftChanges = useMemo(
    () => (draftSegments.length ? diffSnapshots(baseSnapshots, chainSnapshots) : []),
    [draftSegments.length, baseSnapshots, chainSnapshots],
  );

  const draftVerdict = verdict ?? null;

  const handleBuild = () => {
    if (chain.length < 2) {
      message.warning('请至少选择起点与终点两个点位');
      return;
    }
    buildChainSegments(points, chainSnapshots);
    message.success(`已自动串联 ${chain.length - 1} 段路段`);
  };

  /** 把草稿基准同步到最新点位核验并重算判定（草稿内容保留） */
  const handleResync = async () => {
    await refreshBase(chainSnapshots);
    computeVerdict(chainStates);
    setConflict(null);
    message.success('已按最新点位核验重算，可再次保存');
  };

  const handleSave = async () => {
    if (!draftSegments.length) {
      message.warning('请先串联路段');
      return;
    }
    setSaving(true);
    try {
      const n = await saveRoute();
      message.success(`已保存 ${n} 段路线`);
      resetDraft();
    } catch (e) {
      if (e instanceof RouteConflictError) {
        // 保留草稿，弹窗列出变化点位与字段
        setConflict(e);
      } else {
        message.error(`路线保存失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleReview = async (routeName: string) => {
    setReviewing(routeName);
    try {
      await reviewRoute(routeName);
      message.success(`路线「${routeName}」已按最新点位核验复核，恢复可发布`);
    } catch (e) {
      message.error(`复核失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReviewing('');
    }
  };

  const draftColumns: ColumnsType<DraftSegment> = [
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

  const savedColumns: ColumnsType<RouteSegment> = [
    { title: '路线名称', dataIndex: 'routeName', width: 200 },
    { title: '段序', dataIndex: 'order', width: 70 },
    { title: '起点', dataIndex: 'fromPointId', render: (v: string) => nameOf(v) },
    { title: '终点', dataIndex: 'toPointId', render: (v: string) => nameOf(v) },
    { title: '长度(m)', dataIndex: 'length', width: 100 },
    { title: '障碍数', dataIndex: 'obstacleCount', width: 90 },
    { title: '台阶数', dataIndex: 'stepCount', width: 90 },
    { title: '路缘高差(cm)', dataIndex: 'curbHeight', width: 120 },
    {
      title: '可轮椅通行',
      dataIndex: 'wheelchairPassable',
      width: 120,
      render: (v: boolean) => <StatusBadge value={v ? '可通行' : '不可通行'} kind="route" />,
    },
    {
      title: '复核状态',
      dataIndex: 'reviewStatus',
      width: 100,
      render: (v: RouteSegment['reviewStatus']) => (
        <StatusBadge value={v ?? '待复核'} kind="route" />
      ),
    },
  ];

  /** 已保存路线：按名称分组，实时对照点位核验版本评估可发布状态并重算判定 */
  const savedRoutes = useMemo(() => {
    const byName = new Map<string, RouteSegment[]>();
    for (const s of segments) {
      const list = byName.get(s.routeName) ?? [];
      list.push(s);
      byName.set(s.routeName, list);
    }
    return [...byName.entries()].map(([name, segs]) => {
      const pointIds = [...new Set(segs.flatMap((s) => [s.fromPointId, s.toPointId]))];
      const currentSnapshots = snapshotPoints(points, inspections, rectifies, pointIds);
      const evaluation = evaluateRoute(segs, currentSnapshots);
      const currentVerdict = buildVerdict(
        name,
        segs,
        pointStatesFromData(points, inspections, rectifies, pointIds),
      );
      const originalVerdict = buildVerdict(
        name,
        segs,
        statesFromSnapshots(segs[0]?.pointSnapshots ?? {}),
      );
      return {
        name,
        segs,
        evaluation,
        currentVerdict,
        originalVerdict,
        revision: revisionOfRoute(segs, name),
      };
    });
  }, [segments, points, inspections, rectifies]);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">通行路线编制</h1>
          <Typography.Text type="secondary">
            选择起点与途经点位后自动串联路段，逐段录入障碍数、台阶数与路缘高差，输出全线判定；
            判定绑定沿途点位核验版本，点位核验或整改状态一变，相关路线立即失效待复核。
          </Typography.Text>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="路线编制" size="small">
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
                    computeVerdict(chainStates);
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
                >
                  保存路线
                </Button>
                <Button onClick={resetDraft} data-testid="reset-route">
                  清空编制
                </Button>
              </Space>
            </Form>

            {draftChanges.length ? (
              <Alert
                style={{ marginTop: 12 }}
                type="warning"
                showIcon
                message="沿途点位核验已更新，路线判定需重算"
                description={
                  <>
                    <ChangeList changes={draftChanges} />
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<ReloadOutlined />}
                      style={{ marginTop: 8 }}
                      onClick={handleResync}
                      data-testid="sync-base"
                    >
                      按最新核验重算
                    </Button>
                  </>
                }
                data-testid="draft-stale-alert"
              />
            ) : null}

            <div style={{ marginTop: 16 }} data-testid="draft-segments">
              {draftSegments.length ? (
                <Table<DraftSegment>
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
          <Card title="全线判定" size="small" data-testid="verdict-card">
            {draftVerdict ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space size={8} wrap>
                  <StatusBadge
                    value={draftVerdict.passable ? '可通行' : '不可通行'}
                    kind="route"
                    bordered
                  />
                  <Typography.Text strong data-testid="verdict-name">
                    {draftVerdict.routeName}
                  </Typography.Text>
                </Space>
                <Row gutter={12}>
                  <Col span={12}>
                    <Statistic title="全线长度" value={draftVerdict.totalLength} suffix="m" />
                  </Col>
                  <Col span={12}>
                    <Statistic title="沿途障碍" value={draftVerdict.totalObstacles} suffix="处" />
                  </Col>
                  <Col span={12}>
                    <Statistic title="台阶总数" value={draftVerdict.totalSteps} suffix="级" />
                  </Col>
                  <Col span={12}>
                    <Statistic title="最大路缘高差" value={draftVerdict.maxCurbHeight} suffix="cm" />
                  </Col>
                </Row>
                {draftVerdict.passable ? (
                  <Alert type="success" showIcon message="全线满足轮椅通行条件" />
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    message="存在不可通行因素"
                    description={
                      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                        {draftVerdict.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    }
                  />
                )}
                {draftVerdict.warnings.length ? (
                  <Alert
                    type="info"
                    showIcon
                    message="沿途点位提示"
                    description={
                      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                        {draftVerdict.warnings.map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    }
                    data-testid="verdict-warnings"
                  />
                ) : null}
                <Typography.Text type="secondary" className="gb-muted">
                  判定阈值：路缘高差 ≤ {CURB_PASS}cm 可通行，&gt; {CURB_FAIL}cm 判定不可通行；存在台阶即需绕行；
                  沿途点位最新核验不合格或整改复发时全线判定不可通行。
                </Typography.Text>
              </Space>
            ) : (
              <EmptyState
                title="尚未输出判定"
                description="串联路段并填写实测值后点击「输出全线判定」"
                compact
              />
            )}
          </Card>

          <Card
            title="已编制路线（联动点位核验）"
            size="small"
            style={{ marginTop: 16 }}
            data-testid="saved-routes"
          >
            {savedRoutes.length ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                {savedRoutes.map((r) => (
                  <Card key={r.name} size="small" data-testid={`route-eval-${r.name}`}>
                    <Space direction="vertical" size={6} style={{ width: '100%' }}>
                      <Space size={8} wrap>
                        <StatusBadge value={r.evaluation.status} kind="route" bordered />
                        <Typography.Text strong>{r.name}</Typography.Text>
                        <Tag>v{r.revision}</Tag>
                        <StatusBadge
                          value={r.currentVerdict.passable ? '可通行' : '不可通行'}
                          kind="route"
                        />
                        <Tag>{r.currentVerdict.totalLength} m</Tag>
                        <Tag>台阶 {r.currentVerdict.totalSteps}</Tag>
                        <Tag>障碍 {r.currentVerdict.totalObstacles}</Tag>
                      </Space>
                      {r.evaluation.publishable ? (
                        r.currentVerdict.warnings.length ? (
                          <Typography.Text type="secondary" className="gb-muted">
                            提示：{r.currentVerdict.warnings.join('；')}
                          </Typography.Text>
                        ) : null
                      ) : (
                        <>
                          <Alert
                            type={r.evaluation.status === '已失效' ? 'error' : 'warning'}
                            showIcon
                            message={
                              <Space size={8} wrap>
                                <span>
                                  原判定：{r.originalVerdict.passable ? '可通行' : '不可通行'}
                                </span>
                                <span>复核完成前不作为可发布路线</span>
                              </Space>
                            }
                            description={
                              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                                {r.evaluation.status === '待复核' && !r.evaluation.changes.length ? (
                                  <span>历史路线升级而来，需按当前点位核验复核确认。</span>
                                ) : null}
                                {r.evaluation.changes.length ? (
                                  <>
                                    <span>沿途点位核验变化：</span>
                                    <ChangeList changes={r.evaluation.changes} />
                                  </>
                                ) : null}
                                {r.currentVerdict.reasons.length &&
                                r.currentVerdict.passable !== r.originalVerdict.passable ? (
                                  <span>重算原因：{r.currentVerdict.reasons.join('；')}</span>
                                ) : null}
                              </Space>
                            }
                            data-testid={`route-stale-${r.name}`}
                          />
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            icon={<SafetyCertificateOutlined />}
                            loading={reviewing === r.name}
                            onClick={() => handleReview(r.name)}
                            data-testid={`review-route-${r.name}`}
                          >
                            复核重算并标记可发布
                          </Button>
                        </>
                      )}
                    </Space>
                  </Card>
                ))}
              </Space>
            ) : (
              <EmptyState title="暂无已保存路线" compact />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="已保存路段明细" size="small" style={{ marginTop: 16 }}>
        {segments.length ? (
          <Table<RouteSegment>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={segments}
            columns={savedColumns}
          />
        ) : (
          <EmptyState title="暂无路段记录" description="编制并保存后在此查看" compact />
        )}
      </Card>

      <Modal
        title="保存被拒绝：请按最新核验重算"
        open={Boolean(conflict)}
        onCancel={() => setConflict(null)}
        footer={[
          <Button key="edit" onClick={() => setConflict(null)} data-testid="conflict-keep-editing">
            继续编辑草稿
          </Button>,
          <Button
            key="resync"
            type="primary"
            icon={<ReloadOutlined />}
            onClick={handleResync}
            data-testid="conflict-resync"
          >
            按最新核验重算
          </Button>,
        ]}
        data-testid="save-conflict-modal"
      >
        {conflict ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert type="warning" showIcon message={conflict.message} />
            {conflict.revisionConflict ? (
              <Alert
                type="info"
                showIcon
                message={`路线版本冲突：草稿基于 v${conflict.baseRevision}，当前已保存到 v${conflict.currentRevision}（可能由其他页签写入）`}
                data-testid="conflict-revision"
              />
            ) : null}
            {conflict.changes.length ? (
              <div data-testid="conflict-changes">
                <Typography.Text strong>变化点位与字段：</Typography.Text>
                <ChangeList changes={conflict.changes} />
              </div>
            ) : null}
            <Typography.Text type="secondary" className="gb-muted">
              草稿已保留，重算后再次保存即可覆盖最新版本。
            </Typography.Text>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
