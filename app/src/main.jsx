import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const STAGES = ['起号期', '决策期', '术后恢复期', '成果期', '收尾期'];
const KINDS = ['素人种草', '日常养号', '爆款提权'];
const API = '/api';
const STATUS_LABELS = {
  waiting_key: '待接入图片接口',
  draft: '待生成',
  generating: '生成中',
  review: '待审核',
  approved: '已通过',
  rejected: '已驳回',
  waiting_edit: '待剪辑',
  completed: '已完成',
  unavailable: '未接入',
  error: '异常',
  timeout: '超时',
  active: '待互动',
  handled: '已处理',
  waiting_chrome: '等待Chrome采集',
  unknown: '未知'
};
const REVIEW_ACTIONS = [
  ['review', '标记待审核'],
  ['approved', '标记通过'],
  ['rejected', '标记驳回']
];
const CLIP_ACTIONS = [
  ['completed', '标记完成'],
  ['review', '待确认'],
  ['rejected', '退回处理']
];

async function request(path, options = {}) {
  const isFormData = options.body instanceof FormData;
  const res = await fetch(`${API}${path}`, {
    headers: isFormData ? { ...(options.headers || {}) } : { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `请求失败：${res.status}`);
  }
  return res.json();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function statusClass(status) {
  if (['待生成', '候选待选'].includes(status)) return 'wait';
  if (['已锁定', '可交付'].includes(status)) return 'ready';
  if (['已派发'].includes(status)) return 'report';
  if (['已完成'].includes(status)) return 'ok';
  if (['已取消'].includes(status)) return 'wait';
  if (['素材阻塞', '异常'].includes(status)) return 'bad';
  if (['waiting_key', 'draft', 'waiting_edit', 'unavailable', 'waiting_chrome'].includes(status)) return 'wait';
  if (['generating', 'review'].includes(status)) return 'report';
  if (['approved', 'completed'].includes(status)) return 'ok';
  if (['rejected', 'error', 'timeout', 'unknown'].includes(status)) return 'bad';
  return 'bad';
}

function displayStatus(status) {
  return STATUS_LABELS[status] || status || '未知';
}

async function generateDeliveryAndOpen(slot, onDelivery) {
  const result = await request(`/slots/${slot.id}/delivery`, { method: 'POST' });
  onDelivery({ ...(result.slot || slot), case: result.slot?.case || slot.case });
  return result;
}

function AccessGate({ session, onLogin }) {
  const [accessCode, setAccessCode] = useState('');
  return (
    <section className="hero accessGate">
      <div>
        <p className="eyebrow">局域网工作台</p>
        <h1>输入访问码</h1>
        <p>这个页面用于同局域网电脑访问主机工作台。通过后可以查看今日任务、复制交付内容和标记任务状态。</p>
        <form className="accessForm" onSubmit={(event) => {
          event.preventDefault();
          onLogin(accessCode);
        }}>
          <input
            type="password"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            placeholder="访问码"
            autoFocus
          />
          <button className="primary" disabled={!accessCode.trim()}>进入工作台</button>
        </form>
      </div>
      <div className="stats">
        <Metric label="本机地址" value={session.network?.localUrl || '-'} />
        <Metric label="局域网" value={session.network?.lanEnabled ? '已开放' : '未开放'} />
        <Metric label="访问码" value={session.network?.accessCodeRequired ? '已开启' : '未开启'} />
      </div>
    </section>
  );
}

function App() {
  const [view, setView] = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [review, setReview] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [cases, setCases] = useState([]);
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [caseDetail, setCaseDetail] = useState(null);
  const [viralTemplates, setViralTemplates] = useState([]);
  const [config, setConfig] = useState(null);
  const [session, setSession] = useState(null);
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [caseFormOpen, setCaseFormOpen] = useState(false);
  const [bulkCaseOpen, setBulkCaseOpen] = useState(false);
  const [viralFormOpen, setViralFormOpen] = useState(false);
  const [editingViral, setEditingViral] = useState(null);
  const [deliverySlotOpen, setDeliverySlotOpen] = useState(null);

  async function refresh() {
    const [dash, reviewData, scheduleData, caseRows, viralRows, configData] = await Promise.all([
      request('/dashboard'),
      request('/review'),
      request('/schedule'),
      request('/cases'),
      request('/viral-templates'),
      request('/config')
    ]);
    setDashboard(dash);
    setReview(reviewData);
    setSchedule(scheduleData);
    setCases(caseRows);
    setViralTemplates(viralRows);
    setConfig(configData);
    if (selectedCaseId) {
      const detail = await request(`/cases/${selectedCaseId}`);
      setCaseDetail(detail);
    }
    setLoading(false);
  }

  useEffect(() => {
    let alive = true;
    async function boot() {
      try {
        const sessionData = await request('/session');
        if (!alive) return;
        setSession(sessionData);
        if (sessionData.authRequired && !sessionData.authenticated) {
          setLoading(false);
          return;
        }
        await refresh();
      } catch (err) {
        if (alive) {
          setLoading(false);
          showToast(err.message);
        }
      }
    }
    boot();
    return () => {
      alive = false;
    };
  }, [selectedCaseId]);

  async function login(accessCode) {
    await request('/session/login', { method: 'POST', body: JSON.stringify({ accessCode }) });
    const sessionData = await request('/session');
    setSession(sessionData);
    setLoading(true);
    await refresh();
  }

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(''), 2200);
  }

  async function act(fn, message) {
    try {
      const result = await fn();
      await refresh();
      if (message) showToast(typeof message === 'function' ? message(result) : message);
    } catch (err) {
      showToast(err.message);
    }
  }

  async function copyText(text, message = '已复制') {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    showToast(message);
  }

  async function openCase(id) {
    setSelectedCaseId(id);
    setView('case');
    const detail = await request(`/cases/${id}`);
    setCaseDetail(detail);
  }

  const nav = (
    <div className="nav">
      <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>今日中控台</button>
      <button className={view === 'schedule' ? 'active' : ''} onClick={() => setView('schedule')}>排期规划</button>
      <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}>数据复盘</button>
      <button className={view === 'cases' ? 'active' : ''} onClick={() => setView('cases')}>案例库</button>
      <button className={view === 'viral' ? 'active' : ''} onClick={() => setView('viral')}>爆款链接</button>
      <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>系统配置</button>
    </div>
  );
  const canUseWorkbench = session ? (!session.authRequired || session.authenticated) : false;
  const canOpenLocalPaths = Boolean(session?.canOpenLocalPaths);
  const activeQueueItem = dashboard ? firstPriorityAction(dashboard) : null;

  return (
    <div>
      <header className="topbar">
        <div className="brand">素人种草运营工作台</div>
        {canUseWorkbench && nav}
        {canUseWorkbench && (
          <div className="topActions">
            <button className="button primary" onClick={() => setCaseFormOpen(true)}>新建案例</button>
          </div>
        )}
      </header>
      <main className="page">
        {loading && <div className="empty">加载中</div>}
        {!loading && session?.authRequired && !session?.authenticated && (
          <AccessGate session={session} onLogin={(code) => act(() => login(code), '已进入工作台')} />
        )}
        {!loading && canUseWorkbench && view === 'dashboard' && dashboard && (
          <Dashboard data={dashboard} onOpenCase={openCase} onAct={act} onDelivery={setDeliverySlotOpen} canOpenLocalPaths={canOpenLocalPaths} />
        )}
        {!loading && canUseWorkbench && view === 'review' && review && (
          <ReviewView data={review} onOpenCase={openCase} />
        )}
        {!loading && canUseWorkbench && view === 'schedule' && schedule && (
          <ScheduleView data={schedule} onOpenCase={openCase} onAct={act} onDelivery={setDeliverySlotOpen} canOpenLocalPaths={canOpenLocalPaths} activeQueueItem={activeQueueItem} />
        )}
        {!loading && canUseWorkbench && view === 'cases' && (
          <CasesView cases={cases} onOpenCase={openCase} onNew={() => setCaseFormOpen(true)} onBulk={() => setBulkCaseOpen(true)} onAct={act} canOpenLocalPaths={canOpenLocalPaths} />
        )}
        {!loading && canUseWorkbench && view === 'case' && caseDetail && (
          <CaseDetail detail={caseDetail} onAct={act} onBack={() => setView('cases')} onDelivery={setDeliverySlotOpen} canOpenLocalPaths={canOpenLocalPaths} activeQueueItem={activeQueueItem} />
        )}
        {!loading && canUseWorkbench && view === 'viral' && (
          <ViralView
            templates={viralTemplates}
            onNew={() => {
              setEditingViral(null);
              setViralFormOpen(true);
            }}
            onEdit={(item) => {
              setEditingViral(item);
              setViralFormOpen(true);
            }}
            onAct={act}
          />
        )}
        {!loading && canUseWorkbench && view === 'settings' && config && (
          <SettingsView config={config} onAct={act} canOpenLocalPaths={canOpenLocalPaths} />
        )}
      </main>
      {caseFormOpen && (
        <CaseForm
          onClose={() => setCaseFormOpen(false)}
          onSubmit={(payload) => act(async () => {
            const created = await request('/cases', { method: 'POST', body: JSON.stringify(payload) });
            setCaseFormOpen(false);
            setSelectedCaseId(created.id);
            setView('case');
            return created;
          }, (created) => `案例已创建，排期 ${created.slotsCreated || 0} 条`)}
        />
      )}
      {bulkCaseOpen && (
        <BulkCaseForm
          onClose={() => setBulkCaseOpen(false)}
          onSubmit={(payload) => act(async () => {
            await request('/cases/bulk', { method: 'POST', body: JSON.stringify(payload) });
            setBulkCaseOpen(false);
            setView('cases');
          }, '批量案例已导入')}
        />
      )}
      {viralFormOpen && (
        <ViralForm
          initial={editingViral}
          onClose={() => {
            setEditingViral(null);
            setViralFormOpen(false);
          }}
          onSubmit={(payload) => act(async () => {
            if (editingViral) {
              await request(`/viral-templates/${editingViral.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
            } else {
              await request('/viral-templates', { method: 'POST', body: JSON.stringify(payload) });
            }
            setEditingViral(null);
            setViralFormOpen(false);
          }, editingViral ? '爆款分析已更新' : '爆款链接已记录')}
        />
      )}
      {deliverySlotOpen && (
        <DeliveryModal
          slot={deliverySlotOpen}
          onClose={() => setDeliverySlotOpen(null)}
          onAct={act}
          onCopy={copyText}
          canOpenLocalPaths={canOpenLocalPaths}
          activeQueueItem={activeQueueItem}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Dashboard({ data, onOpenCase, onAct, onDelivery, canOpenLocalPaths }) {
  const accountGroups = groupTodayByAccount(data.todaySlots);
  const operatorMonitorActions = (data.monitorActions || []).filter((item) => item.kind !== '账号采集');
  const strategyActions = operatorMonitorActions.filter((item) => item.kind !== '爆款互动');
  const priorityActions = buildPriorityActions(data, strategyActions);
  const dashboardStats = buildDashboardStats(data, priorityActions);
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">今日 {data.today}</p>
          <h1>运营中控台</h1>
          <p>先处理下面这一条队列：生成、选择、交付、补素材、剪辑和爆款互动都在这里完成，账号清单只做概览。</p>
        </div>
        <div className="stats dashboardStats">
          {dashboardStats.map((item) => <Metric key={item.label} label={item.label} value={item.value} />)}
        </div>
      </section>

      <PriorityActionSection
        items={priorityActions}
        onOpenCase={onOpenCase}
        onAct={onAct}
        onDelivery={onDelivery}
        canOpenLocalPaths={canOpenLocalPaths}
      />

      <section className="panel">
        <div className="sectionHead">
          <h2>今日账号概览</h2>
          <div className="headerActions">
            <span>{accountGroups.length} 个兼职/账号</span>
          </div>
        </div>
        {accountGroups.length === 0 ? <div className="empty">今天没有需要处理的兼职任务</div> : (
          <div className="accountGrid">
            {accountGroups.map((group) => (
              <AccountTaskCard
                key={group.name}
                group={group}
                onOpenCase={onOpenCase}
              />
            ))}
          </div>
        )}
      </section>

      {data.abnormalCases.length > 0 && <section className="panel">
        <div className="sectionHead">
          <h2>异常账号</h2>
          <span>{data.abnormalCases.length} 个</span>
        </div>
        <div className="caseGrid">
          {data.abnormalCases.map((item) => (
            <button key={item.id} className="caseTile" onClick={() => onOpenCase(item.id)}>
              <strong>{item.weixinNick}</strong>
              <span>{item.caseCode} · {item.project}</span>
              <em>{item.reasons.join(' / ')}</em>
              {item.materialGaps?.length > 0 && <small>缺口：{item.materialGaps.slice(0, 3).map((gap) => `${gap.status}-${gap.label}`).join(' / ')}</small>}
              {item.actions?.[0] && <small>{item.actions[0]}</small>}
            </button>
          ))}
        </div>
      </section>}

    </div>
  );
}

function monitorActionClass(kind) {
  if (kind === '爆款互动') return 'bad';
  if (kind === '失联处理') return 'bad';
  if (kind === '账号采集') return 'wait';
  if (kind === '偏冷补内容') return 'report';
  if (kind === '增长承接') return 'ok';
  return 'ready';
}

function monitorActionSlotLabel(kind) {
  if (kind === '偏冷补内容') return '生成爆款槽位';
  if (kind === '增长承接') return '生成承接槽位';
  return '';
}

function buildDashboardStats(data = {}, priorityActions = []) {
  const counts = data.counts || {};
  const blocked = (counts.blocked || 0) + (counts.materialSync || 0) + (counts.requiredMaterialGaps || 0);
  return [
    { label: '今日待办', value: priorityActions.length },
    { label: '可交付', value: counts.readyDelivery || 0 },
    { label: '出爆款', value: counts.viralAlerts || 0 },
    { label: '阻塞/缺口', value: blocked }
  ];
}

function firstPriorityAction(data = {}) {
  const operatorMonitorActions = (data.monitorActions || []).filter((item) => item.kind !== '账号采集');
  const strategyActions = operatorMonitorActions.filter((item) => item.kind !== '爆款互动');
  return buildPriorityActions(data, strategyActions)[0] || null;
}

function activeQueueMatchesSlot(activeQueueItem, slot) {
  return Boolean(activeQueueItem?.slot?.id && slot?.id && activeQueueItem.slot.id === slot.id);
}

function activeQueueMatchesClip(activeQueueItem, task) {
  return Boolean(activeQueueItem?.clipTask?.id && task?.id && activeQueueItem.clipTask.id === task.id);
}

function activeQueueMatchesAlert(activeQueueItem, alert) {
  return Boolean(activeQueueItem?.alert?.id && alert?.id && activeQueueItem.alert.id === alert.id);
}

function buildPriorityActions(data = {}, strategyActions = []) {
  const items = [];
  (data.viralAlerts || []).forEach((alert) => {
    items.push({
      id: `alert-${alert.id}`,
      priority: alert.level === 'high' ? 120 : 110,
      kind: '爆款互动',
      status: alert.level === 'high' ? '强信号' : '有苗头',
      statusClass: alert.level === 'high' ? 'bad' : 'report',
      title: `${alert.case?.weixinNick || '未知账号'} 出爆款`,
      detail: `${alert.video?.title || alert.video?.url || '未命名作品'}｜播放 ${formatNumber(alert.snapshot?.plays)}｜评论 ${formatNumber(alert.snapshot?.comments)}`,
      note: alert.interactionNote || '安排助理号/阑尾号进评论区互动和承接。',
      case: alert.case,
      alert
    });
  });
  (data.readyDelivery || []).forEach((slot) => {
    items.push({
      id: `delivery-${slot.id}`,
      priority: 100,
      kind: '微信交付',
      status: slot.status,
      title: `发给 ${slot.case?.weixinNick || '未命名兼职'}`,
      detail: `${slot.contentKind}｜${slot.selectedCandidate?.title || slot.goal}`,
      note: '在网页交付弹窗里复制文案，下载图片或视频，通过微信发送。',
      case: slot.case,
      slot
    });
  });
  (data.todaySlots || []).filter((slot) => slot.status === '已锁定').forEach((slot) => {
    items.push({
      id: `locked-${slot.id}`,
      priority: 88,
      kind: '生成交付',
      status: slot.status,
      title: `${slot.case?.weixinNick || '未命名兼职'} 已锁定文案`,
      detail: `${slot.contentKind}｜${slot.selectedCandidate?.title || slot.goal}`,
      note: '生成网页交付内容后，就能复制文案和发送素材。',
      case: slot.case,
      slot
    });
  });
  (data.pendingChoose || []).forEach((slot) => {
    items.push({
      id: `choose-${slot.id}`,
      priority: 82,
      kind: '选候选',
      status: slot.status,
      title: `${slot.case?.weixinNick || '未命名兼职'} 等待选稿`,
      detail: `${slot.contentKind}｜候选 ${slot.candidateCount || 0} 条`,
      note: '进案例详情，从 3 条候选里选一条锁定。',
      case: slot.case,
      slot
    });
  });
  (data.todaySlots || []).filter((slot) => ['素材阻塞', '异常'].includes(slot.status)).forEach((slot) => {
    items.push({
      id: `blocked-${slot.id}`,
      priority: slot.status === '异常' ? 79 : 78,
      kind: slot.status === '异常' ? '异常处理' : '补素材',
      status: slot.status,
      statusClass: 'bad',
      title: `${slot.case?.weixinNick || '未命名兼职'} 不能交付`,
      detail: `${slot.contentKind}｜${slot.selectedCandidate?.title || slot.goal}`,
      note: slot.status === '异常' ? '先打开案例查看异常原因，再决定重生成或人工处理。' : '先补素材或同步共享素材，再重新生成交付内容。',
      case: slot.case,
      slot
    });
  });
  (data.materialSync || []).forEach((row) => {
    items.push({
      id: `sync-${row.caseId}`,
      priority: row.status === '目录不可用' ? 78 : 76,
      kind: '素材同步',
      status: row.status,
      statusClass: row.status === '目录不可用' ? 'bad' : 'wait',
      title: `${row.case?.weixinNick || '未知账号'} 有共享素材要处理`,
      detail: `${row.sourceDir || '未填写共享目录'}｜待同步 ${row.unsyncedCount || 0} 个`,
      note: row.status === '目录不可用' ? '先检查登记的共享原始素材路径。' : '点击同步，把共享目录里的新素材纳入这个案例。',
      case: row.case,
      materialSync: row
    });
  });
  (data.pendingGenerate || []).forEach((slot) => {
    items.push({
      id: `generate-${slot.id}`,
      priority: 65,
      kind: '生成候选',
      status: slot.status,
      title: `${slot.case?.weixinNick || '未命名兼职'} 今天缺内容`,
      detail: `${slot.contentKind}｜${slot.goal}`,
      note: '先让系统生成 3 条候选稿。',
      case: slot.case,
      slot
    });
  });
  strategyActions.forEach((item) => {
    items.push({
      id: `strategy-${item.id}`,
      priority: item.priority || 55,
      kind: item.kind,
      status: item.title,
      statusClass: monitorActionClass(item.kind),
      title: `${item.case?.weixinNick || '未知账号'} 需要账号策略`,
      detail: item.reason,
      note: item.action,
      case: item.case,
      monitorAction: item
    });
  });
  (data.clipTasks || []).forEach((task) => {
    items.push({
      id: `clip-${task.id}`,
      priority: 42,
      kind: '剪辑任务',
      status: displayStatus(task.status),
      statusClass: statusClass(task.status),
      title: `${task.case?.weixinNick || '未知账号'} 要剪辑`,
      detail: task.title,
      note: '查看剪辑要求，剪完或安排发布后标记完成。',
      case: task.case,
      clipTask: task
    });
  });
  (data.todaySlots || []).filter((slot) => slot.status === '已派发').forEach((slot) => {
    items.push({
      id: `sent-${slot.id}`,
      priority: 35,
      kind: '等确认',
      status: slot.status,
      statusClass: 'report',
      title: `${slot.case?.weixinNick || '未命名兼职'} 已派发`,
      detail: `${slot.contentKind}｜${slot.selectedCandidate?.title || slot.goal}`,
      note: '兼职或剪辑确认完成后，在系统标记完成。',
      case: slot.case,
      slot
    });
  });
  return items.sort((a, b) => b.priority - a.priority);
}

function PriorityActionSection({ items, onOpenCase, onAct, onDelivery, canOpenLocalPaths }) {
  const activeItem = items[0];
  const queuedItems = items.slice(1);
  return (
    <section className="panel priorityPanel">
      <div className="sectionHead">
        <h2>今日操作队列</h2>
        <span>{items.length ? `当前 1 / ${items.length}` : '已清空'}</span>
      </div>
      {items.length === 0 ? <div className="empty doneEmpty">今天发完了</div> : (
        <div className="priorityList">
          <div className="priorityRow activePriority" key={activeItem.id}>
            <div className="priorityBadge">
              <strong>{activeItem.kind}</strong>
              <span className={`status ${activeItem.statusClass || statusClass(activeItem.status)}`}>{activeItem.status}</span>
              <span className="queueFlag activeFlag">当前处理</span>
            </div>
            <div className="taskMain">
              <div className="rowTitle">
                {activeItem.case?.id ? <button className="linkButton" onClick={() => onOpenCase(activeItem.case.id)}>{activeItem.title}</button> : <strong>{activeItem.title}</strong>}
              </div>
              <p>{activeItem.detail}</p>
              <small>{activeItem.note}</small>
            </div>
            <PriorityActionButtons
              item={activeItem}
              onOpenCase={onOpenCase}
              onAct={onAct}
              onDelivery={onDelivery}
              canOpenLocalPaths={canOpenLocalPaths}
            />
          </div>
          {queuedItems.length > 0 && (
            <div className="queueSummary">
              <span className="queuedLabel">后面还有 {queuedItems.length} 条排队中</span>
              <small>{summarizeQueuedKinds(queuedItems)}</small>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function summarizeQueuedKinds(items = []) {
  const counts = items.reduce((acc, item) => {
    acc[item.kind] = (acc[item.kind] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).map(([kind, count]) => `${kind} ${count}`).join(' / ');
}

function PriorityActionButtons({ item, onOpenCase, onAct, onDelivery, canOpenLocalPaths }) {
  if (item.alert) {
    return (
      <div className="rowActions">
        {item.alert.video?.url && <a className="button" href={item.alert.video.url} target="_blank">打开作品</a>}
        <button onClick={() => onAct(
          () => request(`/viral-alerts/${item.alert.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'handled', interactionNote: '已安排助理号/阑尾号评论区互动' }) }),
          '爆款互动已标记'
        )}>标记已互动</button>
      </div>
    );
  }
  if (item.slot?.status === '可交付') {
    return (
      <div className="rowActions">
        <button onClick={() => onDelivery(item.slot)}>查看交付</button>
      </div>
    );
  }
  if (item.slot?.status === '已锁定') {
    return (
      <div className="rowActions">
        <button onClick={() => onAct(() => generateDeliveryAndOpen(item.slot, onDelivery), deliveryResultMessage)}>生成交付</button>
        <button onClick={() => item.case?.id && onOpenCase(item.case.id)}>打开案例</button>
      </div>
    );
  }
  if (item.slot?.status === '候选待选') {
    return (
      <div className="rowActions">
        <button onClick={() => item.case?.id && onOpenCase(item.case.id)}>去选择</button>
      </div>
    );
  }
  if (['素材阻塞', '异常'].includes(item.slot?.status)) {
    return (
      <div className="rowActions">
        {item.slot.deliveryDir && <button onClick={() => onDelivery(item.slot)}>查看说明</button>}
        <button onClick={() => item.case?.id && onOpenCase(item.case.id)}>打开案例</button>
      </div>
    );
  }
  if (item.slot?.status === '待生成') {
    return (
      <div className="rowActions">
        <button onClick={() => onAct(() => request(`/slots/${item.slot.id}/generate-candidates`, { method: 'POST' }), '已生成 3 条候选')}>生成候选</button>
        <button onClick={() => item.case?.id && onOpenCase(item.case.id)}>打开案例</button>
      </div>
    );
  }
  if (item.slot?.status === '已派发') {
    return (
      <div className="rowActions">
        {item.slot.deliveryDir && <button onClick={() => onDelivery(item.slot)}>查看交付</button>}
      </div>
    );
  }
  if (item.materialSync) {
    return (
      <div className="rowActions">
        {item.materialSync.status === '待同步' && item.case?.id && <button onClick={() => onAct(
          () => request(`/cases/${item.case.id}/sync-source-materials`, { method: 'POST' }),
          (result) => `已同步共享素材：复制 ${result.copied} 个，新增 ${result.inserted} 个`
        )}>同步素材</button>}
        <button onClick={() => item.case?.id && onOpenCase(item.case.id)}>打开案例</button>
        {canOpenLocalPaths && item.materialSync.sourceDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: item.materialSync.sourceDir }) }), '已打开共享目录')}>打开共享目录</button>}
      </div>
    );
  }
  if (item.monitorAction) {
    return (
      <div className="rowActions">
        {item.case?.douyinUrl && <a className="button" href={item.case.douyinUrl} target="_blank">打开主页</a>}
        {item.monitorAction.kind === '失联处理' && item.case?.id && <button onClick={() => onAct(
          () => request(`/cases/${item.case.id}`, { method: 'PATCH', body: JSON.stringify({ healthStatus: '失联暂停' }) }),
          '已暂停这个账号的自动排期和采集'
        )}>确认暂停</button>}
        {monitorActionSlotLabel(item.monitorAction.kind) && item.case?.id && <button onClick={() => onAct(
          () => request('/douyin-monitor/actions/slot', { method: 'POST', body: JSON.stringify({ caseId: item.case.id, kind: item.monitorAction.kind }) }),
          (result) => result.created ? `已生成：${result.slot.date} ${result.slot.contentKind}` : `已有对应排期：${result.slot.date} ${result.slot.contentKind}`
        )}>{monitorActionSlotLabel(item.monitorAction.kind)}</button>}
      </div>
    );
  }
  if (item.clipTask) {
    return (
      <div className="rowActions">
        <button onClick={() => item.case?.id && onOpenCase(item.case.id)}>查看任务</button>
        {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: item.clipTask.outputDir }) }), '已打开剪辑目录')}>打开目录</button>}
        <button onClick={() => onAct(() => request(`/clip-tasks/${item.clipTask.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) }), '剪辑任务已标记：已完成')}>标记完成</button>
      </div>
    );
  }
  return <div className="rowActions"><button onClick={() => item.case?.id && onOpenCase(item.case.id)}>打开案例</button></div>;
}

const CONTACT_STATUS_PRIORITY = {
  可交付: 100,
  已派发: 90,
  候选待选: 80,
  已锁定: 70,
  待生成: 60,
  素材阻塞: 50,
  异常: 40,
  已完成: 10
};

function sortAccountItems(items = []) {
  return [...items].sort((a, b) => {
    const byStatus = (CONTACT_STATUS_PRIORITY[b.status] || 0) - (CONTACT_STATUS_PRIORITY[a.status] || 0);
    if (byStatus) return byStatus;
    return `${a.date || ''}${a.timeWindow || ''}`.localeCompare(`${b.date || ''}${b.timeWindow || ''}`);
  });
}

function AccountTaskCard({ group, onOpenCase }) {
  const items = sortAccountItems(group.items);
  const first = items[0];
  return (
    <div className="accountCard accountDetailCard">
      <div className="accountCardHead">
        <div>
          <strong>{group.name}</strong>
          <span>{group.items.length} 条任务 · {accountStatusSummary(group)}</span>
        </div>
        {first?.case?.id && <button onClick={() => onOpenCase(first.case.id)}>打开账号</button>}
      </div>
      {first && <small>下一步：{nextActionText(first)}；具体动作在上方「今日操作队列」处理。</small>}
      {items.length > 1 && <small>还有 {items.length - 1} 条同日任务，可到「排期规划」按账号搜索查看。</small>}
    </div>
  );
}

function groupTodayByAccount(slots) {
  const groups = new Map();
  slots.forEach((slot) => {
    const key = slot.case?.id || slot.case?.weixinNick || slot.id;
    if (!groups.has(key)) {
      groups.set(key, {
        name: slot.case?.weixinNick || '未命名兼职',
        case: slot.case || null,
        items: []
      });
    }
    groups.get(key).items.push(slot);
  });
  return Array.from(groups.values()).map(({ name, case: caze, items }) => ({
    name,
    case: caze,
    items: sortAccountItems(items),
    pendingGenerate: items.filter((slot) => slot.status === '待生成').length,
    pendingChoose: items.filter((slot) => slot.status === '候选待选').length,
    locked: items.filter((slot) => slot.status === '已锁定').length,
    blocked: items.filter((slot) => slot.status === '素材阻塞').length,
    readyDelivery: items.filter((slot) => slot.status === '可交付').length,
    sentWaitReport: items.filter((slot) => slot.status === '已派发').length,
    completed: items.filter((slot) => slot.status === '已完成').length
  })).sort((a, b) => {
    const aPriority = Math.max(...a.items.map((slot) => CONTACT_STATUS_PRIORITY[slot.status] || 0));
    const bPriority = Math.max(...b.items.map((slot) => CONTACT_STATUS_PRIORITY[slot.status] || 0));
    return bPriority - aPriority || b.items.length - a.items.length;
  });
}

function accountStatusSummary(group) {
  return [
    ['待生成', group.pendingGenerate],
    ['待选', group.pendingChoose],
    ['已锁定', group.locked],
    ['阻塞', group.blocked],
    ['可交付', group.readyDelivery],
    ['等回传', group.sentWaitReport],
    ['已完成', group.completed]
  ]
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`)
    .join(' · ') || '暂无待办';
}

function nextActionText(slot) {
  if (slot.status === '待生成') return '生成候选稿';
  if (slot.status === '候选待选') return '选择一条候选';
  if (slot.status === '已锁定') return '生成交付内容';
  if (slot.status === '素材阻塞') return '补素材后重新生成交付内容';
  if (slot.status === '可交付') return '打开交付内容，按步骤发微信';
  if (slot.status === '已派发') return '打开交付内容，核对后标记完成';
  if (slot.status === '已完成') return '任务已闭环';
  return '查看任务';
}

function ReviewView({ data, onOpenCase }) {
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">复盘 {data.today}</p>
          <h1>账号表现和运营复盘</h1>
          <p>把排期进度、交付、素材、账号快照和作品表现放在一起看，用来决定下一轮是补养号、加爆款提权，还是推进种草内容。</p>
        </div>
        <div className="stats reviewStats">
          <Metric label="总排期" value={data.totals.slots} />
          <Metric label="已派发" value={data.totals.sent} />
          <Metric label="已完成" value={data.totals.completed} />
          <Metric label="账号快照" value={data.totals.accountSnapshots || 0} />
          <Metric label="爆款提醒" value={data.totals.viralAlerts || 0} />
          <Metric label="可用素材" value={data.totals.usableAssets} />
        </div>
      </section>

      <div className="twoCol">
        <section className="panel">
          <div className="sectionHead"><h2>三类内容进度</h2><span>{data.totals.candidates} 条候选</span></div>
          <div className="reviewGrid">
            {data.contentKindStats.map((item) => (
              <div className="reviewCard" key={item.kind}>
                <div className="rowTitle">
                  <span className={`kind k-${item.kind}`}>{item.kind}</span>
                  <strong>{item.total}</strong>
                </div>
                <small>待生成/待选 {item.pending} · 已进入交付链路 {item.ready}</small>
                <div className="progressBar"><span style={{ width: `${item.total ? Math.round((item.ready / item.total) * 100) : 0}%` }} /></div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="sectionHead"><h2>内容阶段分布</h2><span>{data.totals.slots} 个排期</span></div>
          <div className="reviewGrid">
            {data.stageStats.map((item) => (
              <div className="reviewCard compact" key={item.stage}>
                <strong>{item.stage}</strong>
                <small>{item.slots} 个排期</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="sectionHead"><h2>重点关注账号</h2><span>{data.needsAttention.length} 个</span></div>
        {data.needsAttention.length === 0 ? <div className="empty">暂无需要优先处理的账号</div> : (
          <div className="caseGrid">
            {data.needsAttention.map((item) => (
              <button key={item.id} className="caseTile" onClick={() => onOpenCase(item.id)}>
                <strong>{item.weixinNick}</strong>
                <span>{item.caseCode} · {item.project}</span>
                <em>{[...item.reasons, item.activeViralAlerts?.length ? `爆款 ${item.activeViralAlerts.length}` : '', item.materialGaps ? `素材缺口 ${item.materialGaps}` : ''].filter(Boolean).join(' / ')}</em>
                {item.actions?.[0] && <small>{item.actions[0]}</small>}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="sectionHead"><h2>播放表现前列</h2><span>{data.topAccounts.length} 个</span></div>
        {data.topAccounts.length === 0 ? <div className="empty">系统采集到作品数据后，这里会按播放排序</div> : (
          <div className="metricTable">
            <div className="metricHeader reviewMetricHeader"><span>账号</span><span>采集时间</span><span>粉丝</span><span>最高播放</span><span>点赞</span><span>评论</span><span>变化</span></div>
            {data.topAccounts.map((item) => (
              <div className="metricLine reviewMetricLine" key={item.id}>
                <button className="linkButton" onClick={() => onOpenCase(item.id)}>{item.weixinNick}</button>
                <span>{shortTime(item.latestSnapshot?.collectedAt || item.topVideo?.latestSnapshot?.collectedAt)}</span>
                <span>{formatNumber(item.latestSnapshot?.fans)}</span>
                <span>{formatNumber(item.topVideo?.latestSnapshot?.plays)}</span>
                <span>{formatNumber(item.topVideo?.latestSnapshot?.likes)}</span>
                <span>{formatNumber(item.topVideo?.latestSnapshot?.comments)}</span>
                <span>{item.fanDelta != null ? `粉丝 ${signed(item.fanDelta)}` : '首次记录'}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="sectionHead"><h2>最近采集数据</h2><span>{data.recentCollections.length} 条</span></div>
        {data.recentCollections.length === 0 ? <div className="empty">暂无账号数据</div> : (
          <div className="metricTable">
            <div className="metricHeader reviewMetricHeader"><span>账号</span><span>类型</span><span>时间</span><span>粉丝/播放</span><span>点赞</span><span>评论</span><span>备注</span></div>
            {data.recentCollections.map((item) => (
              <div className="metricLine reviewMetricLine" key={item.id}>
                <button className="linkButton" onClick={() => item.case && onOpenCase(item.case.id)}>{item.case?.weixinNick || '未知账号'}</button>
                <span>{item.type}</span>
                <span>{shortTime(item.collectedAt)}</span>
                <span>{item.type === '账号快照' ? formatNumber(item.fans) : formatNumber(item.plays)}</span>
                <span>{item.type === '账号快照' ? '—' : formatNumber(item.likes)}</span>
                <span>{item.type === '账号快照' ? '—' : formatNumber(item.comments)}</span>
                <span>{item.video?.title || item.note || '—'}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function signed(value) {
  if (value == null) return '—';
  return value >= 0 ? `+${value}` : String(value);
}

function formatNumber(value) {
  if (value === undefined || value === null || value === '') return '—';
  return Number(value).toLocaleString('zh-CN');
}

function shortTime(value) {
  if (!value) return '未采集';
  return String(value).replace('T', ' ').slice(0, 16);
}

function caseAccountLine(caze = {}) {
  return [
    caze.caseCode || caze.douyinId || '未建案例'
  ].filter(Boolean).join(' · ');
}

function ScheduleView({ data, onOpenCase, onAct, onDelivery, canOpenLocalPaths, activeQueueItem }) {
  const [range, setRange] = useState('14');
  const [status, setStatus] = useState('全部状态');
  const [kind, setKind] = useState('全部内容');
  const [query, setQuery] = useState('');
  const endDate = addDaysLocal(data.today, Number(range));
  const filtered = data.slots.filter((slot) => {
    const caze = slot.case || {};
    const q = query.trim().toLowerCase();
    const haystack = `${caze.weixinNick || ''} ${caze.caseCode || ''} ${caze.douyinId || ''} ${slot.goal}`.toLowerCase();
    return slot.date >= data.today
      && slot.date <= endDate
      && (status === '全部状态' || slot.status === status)
      && (kind === '全部内容' || slot.contentKind === kind)
      && (!q || haystack.includes(q));
  });
  const days = Object.entries(filtered.reduce((acc, slot) => {
    if (!acc[slot.date]) acc[slot.date] = [];
    acc[slot.date].push(slot);
    return acc;
  }, {}));

  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">排期 {data.today}</p>
          <h1>全局排期规划</h1>
          <p>按日期查看所有兼职/账号未来要发什么；执行动作回到今日操作队列，排到第一条再处理。</p>
        </div>
        <div className="stats reviewStats">
          <Metric label="总排期" value={data.counts.total} />
          <Metric label="待生成" value={data.counts.pendingGenerate} />
          <Metric label="待选择" value={data.counts.pendingChoose} />
          <Metric label="已锁定" value={data.counts.locked} />
          <Metric label="等完成" value={data.counts.sentWaitDone} />
          <Metric label="已完成" value={data.counts.completed} />
        </div>
      </section>
      <section className="panel">
        <div className="filters scheduleFilters">
          <input placeholder="搜索账号 / 抖音号 / 案例编号 / 目标" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="7">未来 7 天</option>
            <option value="14">未来 14 天</option>
            <option value="30">未来 30 天</option>
            <option value="60">未来 60 天</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['全部状态', '待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '已完成', '异常', '已取消'].map((item) => <option key={item}>{item}</option>)}
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {['全部内容', ...KINDS].map((item) => <option key={item}>{item}</option>)}
          </select>
          <span>{filtered.length} 条</span>
        </div>
      </section>
      {days.length === 0 ? <div className="empty">当前筛选条件下没有排期</div> : days.map(([date, items]) => (
        <section className="panel" key={date}>
          <div className="sectionHead"><h2>{date}</h2><span>{items.length} 条</span></div>
          <div className="taskList">
            {items.map((slot) => (
              <ScheduleRow key={slot.id} slot={slot} onOpenCase={onOpenCase} onAct={onAct} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} activeQueueItem={activeQueueItem} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ScheduleRow({ slot, onOpenCase, onAct, onDelivery, canOpenLocalPaths, activeQueueItem }) {
  const caze = slot.case || {};
  const isActiveQueueSlot = activeQueueMatchesSlot(activeQueueItem, slot);
  const hasQueueAction = ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发'].includes(slot.status);
  return (
    <div className="taskRow">
      <div className="dateBox">
        <strong>{slot.timeWindow || '全天'}</strong>
        <span>{slot.stage}</span>
      </div>
      <div className="taskMain">
        <div className="rowTitle">
          <button className="linkButton" onClick={() => caze.id && onOpenCase(caze.id)}>{caze.weixinNick || '未命名账号'}</button>
          <span className={`kind k-${slot.contentKind}`}>{slot.contentKind}</span>
          <span className={`status ${statusClass(slot.status)}`}>{slot.status}</span>
        </div>
        <p>{slot.selectedCandidate?.title || slot.goal}</p>
        <small>{caseAccountLine(caze)} · 候选 {slot.candidateCount}</small>
      </div>
      <div className="rowActions">
        {isActiveQueueSlot && slot.status === '待生成' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/generate-candidates`, { method: 'POST' }), '已生成候选')}>生成候选</button>}
        {isActiveQueueSlot && slot.status === '候选待选' && <button onClick={() => caze.id && onOpenCase(caze.id)}>去选择</button>}
        {isActiveQueueSlot && ['已锁定', '素材阻塞'].includes(slot.status) && <button onClick={() => onAct(() => generateDeliveryAndOpen(slot, onDelivery), deliveryResultMessage)}>生成交付内容</button>}
        {isActiveQueueSlot && slot.deliveryDir && <button onClick={() => onDelivery(slot)}>查看交付内容</button>}
        {isActiveQueueSlot && canOpenLocalPaths && slot.status === '素材阻塞' && caze.localCaseDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.localCaseDir }) }), '已打开素材目录')}>打开素材目录</button>}
        {!isActiveQueueSlot && hasQueueAction && <span className="lockedNote">排到今日队列队首后处理</span>}
      </div>
    </div>
  );
}

function addDaysLocal(base, days) {
  const date = new Date(`${base}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function CasesView({ cases, onOpenCase, onNew, onBulk, onAct, canOpenLocalPaths }) {
  const [query, setQuery] = useState('');
  const [healthFilter, setHealthFilter] = useState('全部状态');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [library, setLibrary] = useState(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const filtered = cases.filter((item) => {
    const q = query.trim().toLowerCase();
    const haystack = `${item.weixinNick} ${item.caseCode} ${item.douyinId} ${item.project} ${personaText(item.persona)}`.toLowerCase();
    const matchQuery = !q || haystack.includes(q);
    const matchHealth = healthFilter === '全部状态' || item.healthStatus === healthFilter;
    return matchQuery && matchHealth;
  });
  const healthOptions = ['全部状态', ...Array.from(new Set(cases.map((item) => item.healthStatus).filter(Boolean)))];
  async function loadCaseLibrary() {
    setLibraryOpen(true);
    setLibraryLoading(true);
    try {
      setLibrary(await request('/case-library'));
    } finally {
      setLibraryLoading(false);
    }
  }
  return (
    <div className="stack">
      <section className="panel">
        <div className="sectionHead">
          <h2>案例库</h2>
          <div className="inlineActions">
            <button onClick={loadCaseLibrary}>{libraryOpen ? '重新扫描服务器案例库' : '扫描服务器案例库'}</button>
            <button onClick={onBulk}>批量导入</button>
            <button className="button primary" onClick={onNew}>新建案例</button>
          </div>
        </div>
        {libraryOpen && (
          <CaseLibraryPanel
            library={library}
            loading={libraryLoading}
            onReload={loadCaseLibrary}
            onRegister={(item) => registerLibraryCase(item, onAct, loadCaseLibrary)}
            onOpenCase={onOpenCase}
            onAct={onAct}
            canOpenLocalPaths={canOpenLocalPaths}
          />
        )}
        <div className="filters">
          <input placeholder="搜索微信昵称 / 抖音号 / 案例编号 / 项目 / 人设" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={healthFilter} onChange={(e) => setHealthFilter(e.target.value)}>
            {healthOptions.map((item) => <option key={item}>{item}</option>)}
          </select>
          <span>{filtered.length} / {cases.length}</span>
        </div>
        {cases.length === 0 ? <div className="empty">还没有案例</div> : filtered.length === 0 ? <div className="empty">没有匹配的案例</div> : (
          <div className="caseGrid">
            {filtered.map((item) => (
              <div key={item.id} className="caseTile caseTileBox">
                <button className="caseTileMain" onClick={() => onOpenCase(item.id)}>
                  <strong>{item.weixinNick}</strong>
                  <span>{item.caseCode} · {item.project}</span>
                  <em>{item.douyinId || '未填抖音号'} · {item.healthStatus}</em>
                </button>
                <button className="dangerButton" onClick={() => deleteCase(item, onAct)}>删除</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CaseLibraryPanel({ library, loading, onReload, onRegister, onOpenCase, onAct, canOpenLocalPaths }) {
  const candidates = library?.candidates || [];
  const pending = candidates.filter((item) => !item.alreadyRegistered);
  return (
    <div className="libraryPanel">
      <div className="hintBox">
        服务器案例库用于读取工作人员在共享盘里整理好的待分配案例。登记后会绑定这个目录、同步素材到本地案例目录，并自动生成近期排期。
      </div>
      <div className="templateList">
        <div className="templateRow">
          <strong>服务器案例库根目录</strong>
          <span>{library?.root || '未扫描'}</span>
          <div className="inlineActions">
            <button onClick={onReload}>{loading ? '扫描中' : '刷新'}</button>
            {canOpenLocalPaths && library?.root && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: library.root }) }), '已打开服务器案例库根目录')}>打开根目录</button>}
          </div>
        </div>
        <div className="templateRow">
          <strong>候选目录</strong>
          <span>{loading ? '扫描中' : `${candidates.length} 个，未登记 ${pending.length} 个`}</span>
        </div>
      </div>
      {!loading && candidates.length === 0 ? <div className="empty">没有扫到可登记的案例目录。把待分配案例文件夹放到服务器案例库根目录后再刷新。</div> : (
        <div className="assetList libraryList">
          {candidates.slice(0, 40).map((item) => (
            <div className="assetRow libraryRow" key={item.sourceMaterialDir}>
              <div className="rowTitle">
                <span className={`status ${item.alreadyRegistered ? 's-ok' : 's-pending'}`}>{item.alreadyRegistered ? '已登记' : '未登记'}</span>
                <strong>{item.name}</strong>
              </div>
              <span>{item.project} · 图片 {item.imageCount} · 视频 {item.videoCount} · 文案 {item.textCount}</span>
              <small>{item.relativePath}</small>
              <small>{item.sourceMaterialDir}</small>
              <div className="inlineActions">
                {item.alreadyRegistered ? (
                  <button onClick={() => onOpenCase(item.caseId)}>打开案例</button>
                ) : (
                  <button className="primary" onClick={() => onRegister(item)}>登记案例</button>
                )}
                {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: item.sourceMaterialDir }) }), '已打开服务器案例目录')}>打开目录</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function registerLibraryCase(item, onAct, onDone) {
  const weixinNick = window.prompt('兼职微信昵称（必须，用来知道发给谁）', item.suggestedWeixinNick || item.name || '');
  if (!weixinNick || !weixinNick.trim()) return;
  const douyinUrl = window.prompt('抖音主页/作品链接（可以先空着，后面编辑案例补）', '');
  if (douyinUrl === null) return;
  onAct(async () => {
    const result = await request('/case-library/register', {
      method: 'POST',
      body: JSON.stringify({
        sourceMaterialDir: item.sourceMaterialDir,
        weixinNick: weixinNick.trim(),
        douyinUrl: douyinUrl.trim(),
        project: item.project,
      })
    });
    await onDone();
    return result;
  }, (result) => `已登记「${result.case.weixinNick}」：同步素材 ${result.sync.inserted} 个，排期 ${result.slotsCreated} 条`);
}

function deleteCase(item, onAct) {
  if (!window.confirm(`删除案例「${item.weixinNick}」？系统会移除数据库记录，并同步删除本地案例素材目录。`)) return;
  if (!window.confirm('再次确认删除？删除后首页不会再显示这个案例，本地案例素材目录也不会保留。')) return;
  onAct(() => request(`/cases/${item.id}`, { method: 'DELETE' }), (result) => result.removedDir ? '案例已删除，本地素材目录已同步删除' : '案例已删除，本地目录原本不存在');
}

function caseCanResume(caze = {}) {
  return ['失联暂停', '已放弃', '停用'].includes(caze.healthStatus);
}

function CaseDetail({ detail, onAct, onBack, onDelivery, canOpenLocalPaths, activeQueueItem }) {
  const { case: caze, slots, candidates, assets, imageTasks, clipTasks = [], monitor = {}, videos = [], viralAlerts = [], metrics = [], materialGaps = [], healthReasons = [], healthActions = [] } = detail;
  const [editOpen, setEditOpen] = useState(false);
  const candidatesBySlot = useMemo(() => {
    const map = {};
    candidates.forEach((item) => {
      map[item.slotId] = map[item.slotId] || [];
      map[item.slotId].push(item);
    });
    return map;
  }, [candidates]);
  const clipTaskBySlot = useMemo(() => {
    const map = {};
    clipTasks.forEach((task) => {
      if (task.planSlotId && !map[task.planSlotId]) map[task.planSlotId] = task;
    });
    return map;
  }, [clipTasks]);
  return (
    <div className="stack">
      <button className="back" onClick={onBack}>返回案例库</button>
      <section className="caseHeader">
        <div>
          <p className="eyebrow">{caze.caseCode}</p>
          <h1>{caze.weixinNick}</h1>
          <p>{caze.project} · {personaText(caze.persona)}</p>
          {healthReasons.length > 0 && <p className="healthLine">当前提示：{healthReasons.join(' / ')}</p>}
          {healthActions.length > 0 && <p className="healthLine">建议动作：{healthActions.join(' / ')}</p>}
          <p className="path">共享原始素材：{caze.sourceMaterialDir || '未填写'}</p>
          <p className="path">素材目录：{caze.localCaseDir}</p>
        </div>
        <div className="headerActions">
          <button onClick={() => setEditOpen(true)}>编辑案例</button>
          <button disabled={!caze.sourceMaterialDir} onClick={() => onAct(
            () => request(`/cases/${caze.id}/sync-source-materials`, { method: 'POST' }),
            (result) => `已同步共享素材：复制 ${result.copied} 个，新增 ${result.inserted} 个`
          )}>同步共享素材</button>
          <button onClick={() => onAct(() => request(`/cases/${caze.id}/scan-assets`, { method: 'POST' }), '素材扫描完成')}>扫描素材</button>
          {canOpenLocalPaths && caze.sourceMaterialDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.sourceMaterialDir }) }), '已打开共享素材目录')}>打开共享目录</button>}
          {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.localCaseDir }) }), '已打开案例目录')}>打开素材目录</button>}
          {caze.douyinUrl && <a className="button" href={caze.douyinUrl} target="_blank">打开抖音主页</a>}
          {caseCanResume(caze) && <button className="primary" onClick={() => onAct(
            () => request(`/cases/${caze.id}/resume`, { method: 'POST' }),
            (result) => `已恢复账号：取消旧派发 ${result.canceledCount} 条，新排期 ${result.slotsCreated} 条`
          )}>恢复账号</button>}
        </div>
      </section>
      {editOpen && (
        <CaseForm
          initial={caze}
          onClose={() => setEditOpen(false)}
          onSubmit={(payload) => onAct(async () => {
            await request(`/cases/${caze.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
            setEditOpen(false);
          }, '案例信息已更新')}
        />
      )}

      <section className="panel">
        <div className="sectionHead"><h2>内容排期</h2><span>{slots.length} 条</span></div>
        {slots.length === 0 ? <div className="empty">还没有排期槽位</div> : (
          <div className="slotList">
            {slots.map((slot) => (
              <SlotCard
                key={slot.id}
                slot={slot}
                candidates={candidatesBySlot[slot.id] || []}
                existingClipTask={clipTaskBySlot[slot.id] || null}
                caze={caze}
                onAct={onAct}
                onDelivery={onDelivery}
                canOpenLocalPaths={canOpenLocalPaths}
                activeQueueItem={activeQueueItem}
              />
            ))}
          </div>
        )}
      </section>

      <section className="twoCol">
        <div className="panel">
          <div className="sectionHead"><h2>素材清单</h2><span>{assets.length} 个</span></div>
          {assets.length === 0 ? <div className="empty">把素材放入 00-原始素材 后点击扫描</div> : (
            <div className="assetList">
              {assets.slice(0, 30).map((asset) => (
                <div className="assetRow assetEditable" key={asset.id}>
                  <strong>{asset.kind}</strong>
                  <span>{asset.stage} · {asset.usage} · {asset.source} · {asset.reviewStatus}</span>
                  <small>{asset.path}</small>
                  {asset.originPath && <small>来源：{asset.originPath}</small>}
                  <div className="inlineActions">
                    {['可用', '需处理', '不可用'].map((status) => (
                      <button key={status} onClick={() => onAct(() => request(`/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ reviewStatus: status }) }), `素材已标记：${status}`)}>{status}</button>
                    ))}
                    {['案例人物', '案例过程', '案例对比', '案例场景', '日常素材'].map((usage) => (
                      <button key={usage} onClick={() => onAct(() => request(`/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ usage }) }), `素材用途已标记：${usage}`)}>{usage}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="sectionHead"><h2>素材缺口</h2><span>{materialGaps.filter((gap) => gap.status !== '已满足').length} 项待处理</span></div>
          {materialGaps.length === 0 ? <div className="empty">暂无素材模板</div> : (
            <div className="gapList">
              {materialGaps.map((gap) => (
                <div className={`gapRow ${gap.status === '必补' ? 'required' : ''}`} key={gap.key}>
                  <div>
                    <strong>{gap.label}</strong>
                    <span>{gap.stage} · {gap.count} 个素材</span>
                  </div>
                  <em>{gap.status}</em>
                  <small>{gap.suggestion}</small>
                  {gap.status !== '已满足' && (
                    <div className="inlineActions gapActions">
                      <button onClick={() => onAct(() => request('/image-tasks', {
                        method: 'POST',
                        body: JSON.stringify({
                          caseId: caze.id,
                          purpose: gap.label,
                          prompt: `为${personaText(caze.persona)}生成/整理一张用于「${gap.label}」的${caze.project}内容辅助图，适合抖音图文发布，画面自然，手机拍摄质感。`
                        })
                      }), '已按素材缺口创建图片任务')}>创建图片任务</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="panel">
          <div className="sectionHead">
            <h2>剪辑任务</h2>
            <span>来自具体排期</span>
          </div>
          {clipTasks.length === 0 ? <div className="empty">暂无剪辑任务</div> : (
            <div className="assetList">
              {clipTasks.map((task) => (
                <ClipTaskRow
                  key={task.id}
                  task={task}
                  onAct={onAct}
                  canOpenLocalPaths={canOpenLocalPaths}
                  activeQueueItem={activeQueueItem}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="twoCol">
        <div className="panel">
          <div className="sectionHead">
            <h2>图片任务</h2>
            <span>来自素材缺口</span>
          </div>
          {imageTasks.length === 0 ? <div className="empty">暂无图片任务</div> : (
            <div className="assetList">
              {imageTasks.map((task) => (
                <div className="assetRow" key={task.id}>
                  <strong>{task.purpose}</strong>
                  <span>{displayStatus(task.status)}</span>
                  <small>{task.prompt}</small>
                  <GeneratedImageStrip files={task.generatedFiles || []} />
                  <div className="inlineActions">
                    <button onClick={() => generateImageTask(task, onAct)}>生成图片</button>
                    {REVIEW_ACTIONS.map(([status, label]) => (
                      <button key={status} onClick={() => onAct(() => request(`/image-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), `图片任务已标记：${displayStatus(status)}`)}>{label}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="sectionHead"><h2>账号监控</h2><span>{videos.length} 条作品</span></div>
        {!monitor.latestSnapshot && videos.length === 0 ? <div className="empty">填写抖音主页后，后台采集完成会在这里显示粉丝和作品数据</div> : (
          <div className="metricTable">
            <div className="metricHeader"><span>初始粉丝</span><span>最新粉丝</span><span>粉丝变化</span><span>作品数</span><span>最近采集</span><span>采集状态</span></div>
            <div className="metricLine">
              <span>{formatNumber(monitor.initialSnapshot?.fans)}</span>
              <span>{formatNumber(monitor.latestSnapshot?.fans)}</span>
              <span>{monitor.fanDelta != null ? signed(monitor.fanDelta) : '—'}</span>
              <span>{formatNumber(monitor.latestSnapshot?.totalWorks ?? monitor.videos)}</span>
              <span>{shortTime(monitor.lastCollectedAt)}</span>
              <span>{monitor.dueCollection ? '待采集' : '正常'}</span>
            </div>
            {(monitor.activityTier || monitor.postingStrategy || monitor.collectionPolicy) && (
              <div className="deliveryMeta">
                <span>活跃度：{monitor.activityTier || '未判断'}</span>
                <span>排期：{monitor.postingStrategy?.mode || '默认'}</span>
                <span>采集：{monitor.collectionPolicy?.intervalHours == null ? '不采集' : `${monitor.collectionPolicy.intervalHours}小时`}</span>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="sectionHead"><h2>作品数据</h2><span>{videos.length} 条</span></div>
        {videos.length === 0 ? <div className="empty">采集到作品后，这里会显示每条作品的播放、点赞、评论，并自动标记爆款</div> : (
          <div className="metricTable">
            <div className="metricHeader reviewMetricHeader"><span>作品</span><span>发布时间</span><span>播放</span><span>点赞</span><span>评论</span><span>状态</span><span>动作</span></div>
            {videos.map((video) => (
              <div className="metricLine reviewMetricLine" key={video.id}>
                <span>{video.title || video.url || '未命名作品'}</span>
                <span>{video.publishTime || '—'}</span>
                <span>{formatNumber(video.latestSnapshot?.plays)}</span>
                <span>{formatNumber(video.latestSnapshot?.likes)}</span>
                <span>{formatNumber(video.latestSnapshot?.comments)}</span>
                <span>{video.activeAlert ? '爆款提醒' : '正常'}</span>
                <span>{video.url ? <a href={video.url} target="_blank">打开作品</a> : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {viralAlerts.length > 0 && (
        <section className="panel">
          <div className="sectionHead"><h2>爆款互动</h2><span>{viralAlerts.length} 条</span></div>
          <div className="taskList">
            {viralAlerts.map((alert) => (
              <ViralAlertRow key={alert.id} alert={alert} onAct={onAct} activeQueueItem={activeQueueItem} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

async function generateImageTask(task, onAct) {
  await onAct(
    () => request(`/image-tasks/${task.id}/generate`, { method: 'POST' }),
    (result) => `图片已生成 ${result.files?.length || 0} 张，等待审核`
  );
}

function ClipTaskRow({ task, onAct, canOpenLocalPaths, activeQueueItem }) {
  const isActiveQueueClip = activeQueueMatchesClip(activeQueueItem, task);
  return (
    <div className="assetRow">
      <strong>{task.title}</strong>
      <span>{displayStatus(task.status)}</span>
      {task.brief && <pre className="taskBrief">{task.brief.split('\n').slice(0, 14).join('\n')}</pre>}
      <small>{task.outputDir}</small>
      <div className="inlineActions">
        {isActiveQueueClip && canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: task.outputDir }) }), '已打开剪辑目录')}>打开目录</button>}
        {isActiveQueueClip && CLIP_ACTIONS.map(([status, label]) => (
          <button key={status} onClick={() => onAct(() => request(`/clip-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), `剪辑任务已标记：${displayStatus(status)}`)}>{label}</button>
        ))}
        {!isActiveQueueClip && <span className="lockedNote">排到今日队列队首后处理</span>}
      </div>
    </div>
  );
}

function ViralAlertRow({ alert, onAct, activeQueueItem }) {
  const isActiveQueueAlert = activeQueueMatchesAlert(activeQueueItem, alert);
  return (
    <div className="taskRow">
      <div className="taskMain">
        <div className="rowTitle"><strong>{alert.video?.title || '爆款作品'}</strong><span className="status report">待互动</span></div>
        <p>{alert.reason}</p>
        <small>{alert.interactionNote}</small>
      </div>
      <div className="rowActions">
        {alert.video?.url && <a className="button" href={alert.video.url} target="_blank">打开作品</a>}
        {isActiveQueueAlert && <button onClick={() => onAct(
          () => request(`/viral-alerts/${alert.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'handled', interactionNote: '已安排助理号/阑尾号评论区互动' }) }),
          '爆款互动已标记'
        )}>标记已安排互动</button>}
        {!isActiveQueueAlert && <span className="lockedNote">排到今日队列队首后处理</span>}
      </div>
    </div>
  );
}

function deliveryResultMessage(result) {
  if (!result?.blocked) return '交付内容已生成';
  if (result.reason === 'compliance_hits') return '文案命中合规提示，已打开说明';
  return '缺少素材，已打开阻塞说明';
}

function SlotCard({ slot, candidates, existingClipTask, caze, onAct, onDelivery, canOpenLocalPaths, activeQueueItem }) {
  const selected = candidates.find((item) => item.selected);
  const isActiveQueueSlot = activeQueueMatchesSlot(activeQueueItem, slot);
  const hasQueueAction = ['待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '异常'].includes(slot.status);
  const canSelectCandidate = isActiveQueueSlot && slot.status === '候选待选';
  const canGenerateDelivery = isActiveQueueSlot && selected && (['素材阻塞', '异常'].includes(slot.status) || (slot.status === '已锁定' && !slot.deliveryDir));
  const canCreateClipTask = isActiveQueueSlot && selected && !existingClipTask && ['已锁定', '素材阻塞', '可交付'].includes(slot.status);
  const canMarkException = isActiveQueueSlot && ['待生成', '候选待选', '已锁定', '素材阻塞'].includes(slot.status);
  return (
    <div className="slotCard">
      <div className="slotTop">
        <div>
          <strong>{slot.date} {slot.timeWindow}</strong>
          <span>{slot.stage} · {slot.contentKind}</span>
        </div>
        <span className={`status ${statusClass(slot.status)}`}>{slot.status}</span>
      </div>
      <p>{slot.goal}</p>
      <div className="inlineActions">
        {isActiveQueueSlot && !selected && ['待生成', '候选待选', '素材阻塞', '异常'].includes(slot.status) && (
          <button onClick={() => onAct(() => request(`/slots/${slot.id}/generate-candidates`, { method: 'POST' }), '已生成候选')}>生成/重 roll</button>
        )}
        {canGenerateDelivery && <button onClick={() => onAct(() => generateDeliveryAndOpen({ ...slot, case: caze }, onDelivery), deliveryResultMessage)}>生成交付内容</button>}
        {canCreateClipTask && <button onClick={() => onAct(() => request('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, planSlotId: slot.id, title: `${slot.date}_${slot.contentKind}_剪辑任务` }) }), (result) => result.alreadyExisting ? '已有剪辑任务' : '剪辑任务已创建')}>创建剪辑任务</button>}
        {existingClipTask && <span className="lockedNote">剪辑任务已建</span>}
        {isActiveQueueSlot && slot.deliveryDir && <button onClick={() => onDelivery({ ...slot, case: caze })}>查看交付内容</button>}
        {isActiveQueueSlot && canOpenLocalPaths && slot.status === '素材阻塞' && caze.localCaseDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.localCaseDir }) }), '已打开素材目录')}>打开素材目录</button>}
        {canMarkException && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '异常' }) }), '已标记异常')}>异常</button>}
        {!isActiveQueueSlot && hasQueueAction && <span className="lockedNote">排到今日队列队首后处理</span>}
      </div>
      {slot.deliveryDir && <div className="path">交付内容已生成，可在网页内查看、复制和下载。</div>}
      {candidates.length > 0 && (
        <div className="draftGrid">
          {candidates.map((draft) => (
            <div className={`draft ${draft.selected ? 'selected' : ''} ${draft.complianceHits?.length ? 'complianceWarning' : ''}`} key={draft.id}>
              <div className="draftHead">
                <strong>{draft.variant}</strong>
                <span>{draft.format}</span>
              </div>
              <h3>{draft.title}</h3>
              <p>{draft.publishText}</p>
              {draft.complianceHits?.length > 0 && (
                <div className="complianceHits">
                  合规提示：{draft.complianceHits.map((hit) => `${hit.rule}「${hit.match}」`).join(' / ')}
                </div>
              )}
              <div className="inlineActions">
                {canSelectCandidate && <button onClick={() => onAct(() => request(`/candidates/${draft.id}/select`, { method: 'POST' }), '已锁定候选')}>{draft.selected ? '已选择' : '选择这条'}</button>}
                {!canSelectCandidate && draft.selected && <span className="lockedNote">已锁定</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveryModal({ slot, onClose, onAct, onCopy, canOpenLocalPaths, activeQueueItem }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    request(`/slots/${slot.id}/delivery-view`)
      .then((data) => {
        if (alive) setView(data);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [slot.id]);

  if (error) {
    return (
      <Modal title="交付内容" onClose={onClose}>
        <div className="empty">{error}</div>
        <div className="modalActions"><button onClick={onClose}>关闭</button></div>
      </Modal>
    );
  }
  if (!view) {
    return (
      <Modal title="交付内容" onClose={onClose}>
        <div className="empty">正在读取交付内容</div>
      </Modal>
    );
  }
  const texts = view.texts || {};
  const mediaFiles = view.mediaFiles || [];
  const imageFiles = mediaFiles.filter((item) => item.kind === '图片');
  const videoFiles = mediaFiles.filter((item) => item.kind === '视频');
  const isActiveQueueSlot = activeQueueMatchesSlot(activeQueueItem, view.slot);
  const steps = deliverySteps(view, mediaFiles.length, isActiveQueueSlot);
  const copyAllowed = view.slot.status === '可交付' && isActiveQueueSlot;
  return (
    <Modal title="交付内容" onClose={onClose}>
      <div className="deliveryHeader">
        <div>
          <strong>当前只发给：{view.case?.weixinNick || '未命名兼职'}</strong>
          <span>{view.slot.date} {view.slot.timeWindow || '全天'}｜{view.slot.contentKind}｜账号：{view.case?.douyinId || '未填抖音号'}</span>
        </div>
        <span className={`status ${statusClass(view.slot.status)}`}>{view.slot.status}</span>
      </div>

      {!copyAllowed && (
        <div className="readonlyNotice">
          {isActiveQueueSlot ? `这条已经进入「${view.slot.status}」状态，交付内容只读，避免重复发给同一个兼职。` : '这条不是今日操作队列的当前任务，交付内容只读；请回到首页按队首顺序处理。'}
        </div>
      )}

      <div className="handoffSteps">
        {steps.map((item) => (
          <div className="handoffStep" key={item.label}>
            <span>{item.order}</span>
            <div>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </div>
          </div>
        ))}
      </div>

      {texts.blockedNote && (
        <div className="textPanel warningPanel">
          <strong>素材阻塞说明</strong>
          <pre>{texts.blockedNote}</pre>
        </div>
      )}
      {texts.complianceNote && (
        <div className="textPanel warningPanel">
          <strong>合规阻塞说明</strong>
          <pre>{texts.complianceNote}</pre>
        </div>
      )}

      <div className="deliveryTextGrid">
        {texts.freelancerGuide && <TextPanel title="兼职须知（首次发送）" text={texts.freelancerGuide} onCopy={onCopy} copyable={copyAllowed} />}
        <TextPanel title="发给兼职文案" text={texts.operatorInstruction} onCopy={onCopy} copyable={copyAllowed} />
        <TextPanel title="抖音发布文案" text={texts.publishText} onCopy={onCopy} copyable={copyAllowed} />
      </div>

      <section className="deliverySection">
        <div className="sectionHead">
          <h2>{view.isVideo ? '本次视频素材' : '本次图文素材'}</h2>
          <span>{mediaFiles.length} 个</span>
        </div>
        {mediaFiles.length === 0 ? <div className="empty">还没有可发送素材，请先补素材或生成图片</div> : (
          <div className="deliveryMediaGrid">
            {imageFiles.map((file) => <MediaCard key={file.path} file={file} label="图片" />)}
            {videoFiles.map((file) => <MediaCard key={file.path} file={file} label="视频" />)}
          </div>
        )}
      </section>

      {texts.assetOrder && <TextPanel title="素材发送顺序" text={texts.assetOrder} onCopy={onCopy} copyable={false} />}
      {texts.publishRules && <TextPanel title="发布要求" text={texts.publishRules} onCopy={onCopy} copyable={copyAllowed} />}

      {view.isVideo && (
        <section className="deliverySection">
          <div className="sectionHead"><h2>视频剪辑</h2><span>剪辑人员使用</span></div>
          <div className="deliveryTextGrid">
            <TextPanel title="口播/字幕文案" text={texts.voiceover} onCopy={onCopy} copyable={copyAllowed} />
            <TextPanel title="剪辑要求" text={texts.editBrief} onCopy={onCopy} copyable={copyAllowed} />
          </div>
          <div className="deliveryPaths">
            <div><strong>成片保存到</strong><span>{view.editing?.finalVideoPath}</span></div>
            <div><strong>封面保存到</strong><span>{view.editing?.coverPath}</span></div>
            {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: view.deliveryDir }) }), '已打开剪辑目录')}>打开剪辑目录</button>}
          </div>
          {view.sourceAssets?.length > 0 && (
            <div className="sourceList">
              <strong>可用源素材</strong>
              {view.sourceAssets.slice(0, 12).map((asset) => (
                <div className="sourceRow" key={asset.id}>
                  <span>{asset.kind}｜{asset.stage}｜{asset.source}</span>
                  <small>{asset.path}</small>
                  <a className="button" href={asset.url} download>下载源素材</a>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <div className="modalActions">
        <button onClick={onClose}>关闭</button>
        {isActiveQueueSlot && view.slot.status === '可交付' && (
          <button className="primary" onClick={() => onAct(async () => {
            await request(`/slots/${view.slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) });
            onClose();
          }, '已标记派发')}>已用微信发送</button>
        )}
        {isActiveQueueSlot && view.slot.status === '已派发' && (
          <button className="primary" onClick={() => onAct(async () => {
            await request(`/slots/${view.slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已完成' }) });
            onClose();
          }, '已标记完成')}>标记完成</button>
        )}
      </div>
    </Modal>
  );
}

function deliverySteps(view, mediaCount, isActiveQueueSlot = true) {
  const readonlyDelivery = view.slot.status !== '可交付' || !isActiveQueueSlot;
  const steps = [
    {
      order: '1',
      label: '先确认微信对象',
      detail: `只发给 ${view.case?.weixinNick || '未命名兼职'}，不要切到下一个账号。`
    },
    {
      order: '2',
      label: readonlyDelivery ? '核对发给兼职文案' : '复制发给兼职文案',
      detail: readonlyDelivery ? '这段已经发过，只用于确认，不再复制发送。' : '这段是微信里的任务说明，不发到抖音。'
    },
    {
      order: '3',
      label: readonlyDelivery ? '核对抖音发布文案' : '复制抖音发布文案',
      detail: readonlyDelivery ? '这段已经发过，只用于确认兼职发布内容。' : '这段给兼职发布抖音，第一行默认做标题。'
    },
    {
      order: '4',
      label: readonlyDelivery ? '核对素材顺序' : (view.isVideo ? '下载或发送视频素材' : '下载或发送图片素材'),
      detail: readonlyDelivery ? `已派发素材只用于核对，本次记录 ${mediaCount} 个素材。` : (mediaCount ? `按页面顺序发送 ${mediaCount} 个素材。` : '没有素材时不要派发，先补素材。')
    }
  ];
  if (view.texts?.freelancerGuide) {
    steps.splice(1, 0, {
      order: '首次',
      label: readonlyDelivery ? '兼职须知已进入记录' : '第一次先发兼职须知',
      detail: readonlyDelivery ? '只用于核对首次口径，不再重复发送。' : '同一个兼职以前发过就不用重复发。'
    });
  }
  steps.push({
    order: String(steps.length + 1),
    label: !isActiveQueueSlot ? '排到队首后再处理' : (view.slot.status === '已派发' ? '确认完成后收尾' : '发完微信后标记已派发'),
    detail: !isActiveQueueSlot ? '先回到今日操作队列，处理当前第一条，避免漏发、错发或重发。' : (view.slot.status === '已派发' ? '兼职确认发布或剪辑交付后，点“标记完成”。' : '按钮只用于当前这个交付内容，点完会从队列里消失。')
  });
  let number = 0;
  return steps.map((item) => ({
    ...item,
    order: item.order === '首次' ? '首次' : String(++number)
  }));
}

function TextPanel({ title, text, onCopy, copyable = true }) {
  return (
    <div className="textPanel">
      <div className="rowTitle">
        <strong>{title}</strong>
        {copyable && text && <button onClick={() => onCopy(text, `${title}已复制`)}>复制</button>}
      </div>
      <pre>{text || '暂无内容'}</pre>
    </div>
  );
}

function MediaCard({ file, label }) {
  return (
    <div className="mediaCard">
      {file.kind === '图片' ? <img src={file.url} alt={file.name} /> : <video src={file.url} controls />}
      <strong>{file.name}</strong>
      <span>{label}</span>
      <a className="button" href={file.url} download>{file.kind === '图片' ? '下载图片' : '下载视频'}</a>
    </div>
  );
}

function GeneratedImageStrip({ files }) {
  if (!files?.length) return null;
  return (
    <div className="generatedImages">
      {files.map((file) => (
        <a href={file.url} download key={file.path}>
          <img src={file.url} alt={file.name} />
          <span>下载图片</span>
        </a>
      ))}
    </div>
  );
}

function ViralView({ templates, onNew, onEdit, onAct }) {
  const sortedTemplates = [...templates].sort((a, b) => Number(isPendingViral(b)) - Number(isPendingViral(a)));
  const pending = sortedTemplates.filter((item) => isPendingViral(item)).length;
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>爆款链接</h2>
        <div className="inlineActions">
          <span>{pending} 条待分析</span>
          <button className="button primary" onClick={onNew}>粘贴爆款链接</button>
        </div>
      </div>
      <div className="hintBox">工作人员只需要把找到的抖音爆款链接放进来。链接会进入待分析状态，不占用今日操作队列；完成内容提取、结构拆解和适合账号判断后，只给可投放账号生成同类型候选。</div>
      {sortedTemplates.length === 0 ? <div className="empty">还没有待分析链接。先粘贴作品链接即可，不需要填写模板内容。</div> : (
        <div className="templateList">
          {sortedTemplates.map((item) => (
            <div className="templateRow" key={item.id}>
              <div className="rowTitle">
                <strong>{isPendingViral(item) ? pendingViralTitle(item) : item.title}</strong>
                <span className={`status ${isPendingViral(item) ? 's-pending' : 's-ready'}`}>{isPendingViral(item) ? '待分析' : '可生成'}</span>
              </div>
              <span>{item.category} · {item.rewritePolicy}</span>
              {item.sourceLink && <small>来源：{item.sourceLink}</small>}
              <p>{isPendingViral(item) ? '等待分析：提取原视频内容、结构和适合账号后再批量生成。' : item.hotStructure}</p>
              {!isPendingViral(item) && <small>{item.rawText}</small>}
              <div className="inlineActions">
                {item.sourceLink && <a className="button" href={item.sourceLink} target="_blank">打开原链接</a>}
                <button onClick={() => onEdit(item)}>{isPendingViral(item) ? '补分析结果' : '编辑分析'}</button>
                <button disabled={isPendingViral(item)} onClick={() => bulkGenerateViral(item, onAct)}>给可投放账号生成爆款候选</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function isPendingViral(item) {
  return String(item.rawText || '').startsWith('待分析')
    || String(item.hotStructure || '').startsWith('待分析')
    || item.category === '待分析';
}

function pendingViralTitle(item) {
  return item.sourceLink ? '待分析爆款链接' : (item.title || '待分析爆款链接');
}

function SettingsView({ config, onAct, canOpenLocalPaths }) {
  const [sharedAssets, setSharedAssets] = useState([]);
  const [sharedAssetsLoading, setSharedAssetsLoading] = useState(false);
  async function loadSharedAssets() {
    setSharedAssetsLoading(true);
    try {
      setSharedAssets(await request('/shared-assets'));
    } finally {
      setSharedAssetsLoading(false);
    }
  }
  useEffect(() => {
    loadSharedAssets();
  }, []);
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">系统配置</p>
          <h1>运行状态</h1>
          <p>这里只保留工作人员会用到的状态：局域网访问、素材目录、图片生成占位、内容阶段比例和素材模板。</p>
        </div>
        <div className="stats">
          <Metric label="图片接口" value={config.image?.ready ? '已接入' : '待接入'} />
          <Metric label="局域网" value={config.network?.lanEnabled ? '已开放' : '本机'} />
          <Metric label="内容阶段" value={config.stages.length} />
          <Metric label="内容类" value={config.contentKinds.length} />
        </div>
      </section>
      <section className="panel">
        <div className="sectionHead">
          <h2>局域网访问</h2>
        </div>
        <div className="templateList">
          <div className="templateRow">
            <strong>本机地址</strong>
            <span>{config.network?.localUrl}</span>
          </div>
          <div className="templateRow">
            <strong>给工作人员的网址</strong>
            <span>{config.network?.lanEnabled && config.network?.lanUrls?.length ? config.network.lanUrls.join(' / ') : '当前未开放局域网访问'}</span>
          </div>
          <div className="templateRow">
            <strong>访问码</strong>
            <span>{config.network?.accessCodeRequired ? '已开启' : '未开启；建议开放局域网时设置 SOUREN_ACCESS_CODE'}</span>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="sectionHead"><h2>本地素材根目录</h2></div>
        <div className="path">{config.materialRoot}</div>
      </section>
      <section className="panel">
        <div className="sectionHead"><h2>服务器案例库</h2><span>未登记 {config.caseLibrary?.unregistered || 0} 个</span></div>
        <div className="path">{config.caseLibraryRoot}</div>
        <div className="templateList">
          <div className="templateRow">
            <strong>可登记目录</strong>
            <span>{config.caseLibrary?.total || 0} 个</span>
          </div>
        </div>
      </section>
      <section className="panel">
        <div className="sectionHead">
          <h2>通用素材库</h2>
          <button onClick={() => onAct(
            async () => {
              const result = await request('/shared-assets/scan', { method: 'POST' });
              await loadSharedAssets();
              return result;
            },
            (result) => `通用素材扫描完成：新增 ${result.inserted} 个`
          )}>扫描通用素材</button>
        </div>
        <div className="path">{config.sharedMaterialRoot}</div>
        <div className="templateList">
          <div className="templateRow">
            <strong>总数</strong>
            <span>{config.sharedAssets?.total || 0} 个</span>
          </div>
          {(config.sharedAssets?.byCategory || []).map((item) => (
            <div className="templateRow" key={item.category}>
              <strong>{item.category}</strong>
              <span>{item.count} 个</span>
            </div>
          ))}
          {(config.sharedAssets?.byUsage || []).map((item) => (
            <div className="templateRow" key={item.usage}>
              <strong>{item.usage}</strong>
              <span>{item.count} 个</span>
            </div>
          ))}
        </div>
      </section>
      <SharedAssetsManager
        assets={sharedAssets}
        loading={sharedAssetsLoading}
        onReload={loadSharedAssets}
        onAct={onAct}
        canOpenLocalPaths={canOpenLocalPaths}
      />
      <section className="panel">
        <div className="sectionHead"><h2>图片生成接口</h2></div>
        <div className="templateList">
          <div className="templateRow">
            <strong>状态</strong>
            <span>{config.image?.ready ? `${config.image.model}｜${config.image.size}` : `${config.image?.missing || '未接入'}，图片任务仍会保留提示词`}</span>
          </div>
        </div>
      </section>
      <section className="twoCol">
        <div className="panel">
          <div className="sectionHead"><h2>内容阶段比例</h2></div>
          <div className="templateList">
            {Object.entries(config.stageRatios).map(([stage, ratios]) => (
              <div className="templateRow" key={stage}>
                <strong>{stage}</strong>
                <span>{Object.entries(ratios).map(([kind, value]) => `${kind} ${Math.round(value * 100)}%`).join(' / ')}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="sectionHead"><h2>素材模板</h2></div>
          <div className="templateList">
            {Object.entries(config.materialTemplates).map(([project, items]) => (
              <div className="templateRow" key={project}>
                <strong>{project}</strong>
                <span>{items.map((item) => `${item.label}${item.required ? '*' : ''}`).join(' / ')}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

const SHARED_ASSET_CATEGORIES = ['医院素材', '套图素材', '生活场景', '文字卡素材', '备用素材'];
const SHARED_ASSET_USAGES = ['合成背景', '套图参考', '通用配图', '文字卡', '通用视频'];
const SHARED_ASSET_STATUSES = ['可用', '待处理', '需处理', '不可用'];

function SharedAssetsManager({ assets, loading, onReload, onAct, canOpenLocalPaths }) {
  const visible = (assets || []).slice(0, 60);
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>通用素材管理</h2>
        <div className="headerActions">
          <span>{loading ? '读取中' : `${assets.length} 个素材`}</span>
          <button onClick={onReload}>刷新列表</button>
        </div>
      </div>
      {visible.length === 0 ? <div className="empty">还没有通用素材。把医院素材、套图素材或生活场景放入通用素材库后，点击“扫描通用素材”。</div> : (
        <div className="sharedAssetGrid">
          {visible.map((asset) => (
            <div className="sharedAssetCard" key={asset.id}>
              <SharedAssetPreview asset={asset} />
              <div className="sharedAssetInfo">
                <strong>{asset.category}</strong>
                <span>{asset.kind} · {asset.usage} · {asset.reviewStatus}</span>
                <small>{asset.path}</small>
              </div>
              <div className="sharedAssetActions">
                <div className="buttonCluster">
                  {SHARED_ASSET_CATEGORIES.map((category) => (
                    <button
                      key={category}
                      className={asset.category === category ? 'activeSmall' : ''}
                      onClick={() => updateSharedAsset(asset, { category }, onAct, onReload)}
                    >{category}</button>
                  ))}
                </div>
                <div className="buttonCluster">
                  {SHARED_ASSET_USAGES.map((usage) => (
                    <button
                      key={usage}
                      className={asset.usage === usage ? 'activeSmall' : ''}
                      onClick={() => updateSharedAsset(asset, { usage }, onAct, onReload)}
                    >{usage}</button>
                  ))}
                </div>
                <div className="buttonCluster">
                  {SHARED_ASSET_STATUSES.map((reviewStatus) => (
                    <button
                      key={reviewStatus}
                      className={asset.reviewStatus === reviewStatus ? 'activeSmall' : ''}
                      onClick={() => updateSharedAsset(asset, { reviewStatus }, onAct, onReload)}
                    >{reviewStatus}</button>
                  ))}
                </div>
                <div className="inlineActions compactActions">
                  {asset.url && <a className="button" href={asset.url} download>{asset.kind === '视频' ? '下载视频' : '下载素材'}</a>}
                  {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: asset.path }) }), '已打开通用素材')}>打开素材</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SharedAssetPreview({ asset }) {
  if (asset.kind === '图片' && asset.url) return <img className="sharedAssetPreview" src={asset.url} alt={asset.path} />;
  if (asset.kind === '视频' && asset.url) return <video className="sharedAssetPreview" src={asset.url} controls />;
  return <div className="sharedAssetPreview placeholder">{asset.kind || '素材'}</div>;
}

function updateSharedAsset(asset, patch, onAct, onReload) {
  onAct(async () => {
    const result = await request(`/shared-assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await onReload();
    return result;
  }, '通用素材已更新');
}

function bulkGenerateViral(template, onAct) {
  const date = window.prompt('生成到哪一天？', today());
  if (!date) return;
  onAct(
    () => request(`/viral-templates/${template.id}/bulk-generate`, {
      method: 'POST',
      body: JSON.stringify({ date })
    }),
    (result) => `已生成 ${result.createdCount} 个爆款候选，跳过 ${result.skippedCount || 0} 个账号`
  );
}

function CaseForm({ initial, onClose, onSubmit }) {
  const isCreate = !initial;
  const [form, setForm] = useState(() => ({
    weixinNick: initial?.weixinNick || '',
    douyinId: initial?.douyinId || '',
    douyinUrl: initial?.douyinUrl || '',
    project: initial?.project || '吸脂',
    sourceMaterialDir: initial?.sourceMaterialDir || '',
    persona: {
      city: initial?.persona?.city || '',
      age: initial?.persona?.age || '',
      occupation: initial?.persona?.occupation || '',
      tone: initial?.persona?.tone || '',
      motivation: initial?.persona?.motivation || ''
    }
  }));
  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function updatePersona(key, value) {
    setForm((prev) => ({ ...prev, persona: { ...prev.persona, [key]: value } }));
  }
  function submit() {
    if (isCreate) {
      onSubmit({
        weixinNick: form.weixinNick,
        douyinUrl: form.douyinUrl,
        project: form.project,
        sourceMaterialDir: form.sourceMaterialDir
      });
      return;
    }
    onSubmit({ ...form, persona: { ...form.persona, age: Number(form.persona.age) || '' } });
  }
  return (
    <Modal title={initial ? '编辑案例' : '新建案例'} onClose={onClose}>
      {isCreate && <div className="hintBox">新建时只填四项：兼职微信昵称、抖音主页/作品链接、项目和共享原始素材路径。系统会自动建立目录和近期排期。</div>}
      <div className="formGrid">
        <label>兼职微信昵称<input value={form.weixinNick} onChange={(e) => update('weixinNick', e.target.value)} /></label>
        <label>抖音主页/作品链接<input value={form.douyinUrl} onChange={(e) => update('douyinUrl', e.target.value)} /></label>
        <label className="wide">项目<input value={form.project} onChange={(e) => update('project', e.target.value)} placeholder="例如：吸脂 / 复诊 / 其他项目" /></label>
        <label className="wide">共享原始素材路径<input value={form.sourceMaterialDir} onChange={(e) => update('sourceMaterialDir', e.target.value)} placeholder="工作人员在共享盘/服务器里放素材的目录路径" /></label>
        {!isCreate && (
          <>
            <label>抖音号<input value={form.douyinId} onChange={(e) => update('douyinId', e.target.value)} /></label>
          </>
        )}
        {!isCreate && (
          <>
            <label>城市<input value={form.persona.city} onChange={(e) => updatePersona('city', e.target.value)} /></label>
            <label>年龄<input value={form.persona.age} onChange={(e) => updatePersona('age', e.target.value)} /></label>
            <label>职业<input value={form.persona.occupation} onChange={(e) => updatePersona('occupation', e.target.value)} /></label>
            <label>语气<input value={form.persona.tone} onChange={(e) => updatePersona('tone', e.target.value)} /></label>
            <label className="wide">动机故事<textarea value={form.persona.motivation} onChange={(e) => updatePersona('motivation', e.target.value)} /></label>
          </>
        )}
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" disabled={isCreate && !form.weixinNick.trim()} onClick={submit}>{initial ? '保存' : '创建'}</button>
      </div>
    </Modal>
  );
}

function BulkCaseForm({ onClose, onSubmit }) {
  const [text, setText] = useState('小林,https://www.douyin.com/user/example1,吸脂,/Volumes/共享素材/小林\n小陈,https://www.douyin.com/user/example2,复诊,/Volumes/共享素材/小陈');
  return (
    <Modal title="批量导入兼职/账号" onClose={onClose}>
      <div className="hintBox">
        每行一个账号，支持逗号或 Tab 分隔。字段顺序：
        微信昵称, 抖音主页链接, 项目, 共享原始素材路径（可选）。导入后系统会自动建立近期排期。
      </div>
      <div className="formGrid">
        <label className="wide">导入内容<textarea rows="10" value={text} onChange={(e) => setText(e.target.value)} /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit({ text })}>导入</button>
      </div>
    </Modal>
  );
}

function ViralForm({ initial, onClose, onSubmit }) {
  const isEditing = Boolean(initial);
  const [form, setForm] = useState(() => ({
    title: initial?.title || '',
    rawText: initial?.rawText || '',
    sourceLink: initial?.sourceLink || '',
    category: initial?.category || '待分析',
    hotStructure: initial?.hotStructure || '',
    suitableText: initial?.suitablePersonas?.join(',') || '',
    forbiddenText: initial?.forbiddenPersonas?.join(',') || '',
    rewritePolicy: initial?.rewritePolicy || '仅参考'
  }));
  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function submit() {
    if (!isEditing) {
      onSubmit({ sourceLink: form.sourceLink });
      return;
    }
    onSubmit({
      ...form,
      suitablePersonas: form.suitableText.split(/,|，|\n/).map((item) => item.trim()).filter(Boolean),
      forbiddenPersonas: form.forbiddenText.split(/,|，|\n/).map((item) => item.trim()).filter(Boolean)
    });
  }
  return (
    <Modal title={isEditing ? '补爆款分析' : '粘贴爆款链接'} onClose={onClose}>
      <div className="hintBox">{isEditing ? '这里用于把原视频内容、结构分析和适合账号补回系统。补完后，这条爆款链接就可以批量生成人设化候选。' : '工作人员只需要贴抖音作品链接，系统会先记录为待分析任务。'}</div>
      <div className="formGrid">
        <label className="wide">爆款视频链接<input placeholder="先贴抖音作品链接即可" value={form.sourceLink} onChange={(e) => update('sourceLink', e.target.value)} /></label>
        {isEditing && (
          <>
            <label className="wide">备注标题<input placeholder="分析后填写，用来区分这个爆款" value={form.title} onChange={(e) => update('title', e.target.value)} /></label>
            <label className="wide">原视频内容<textarea rows="5" placeholder="提取后的标题、口播或字幕正文" value={form.rawText} onChange={(e) => update('rawText', e.target.value)} /></label>
            <label>类别<select value={form.category} onChange={(e) => update('category', e.target.value)}>
              {['待分析', '情绪', '职场', '穿搭', '美食', '本地生活', '清单', '反差故事'].map((item) => <option key={item}>{item}</option>)}
            </select></label>
            <label>改写策略<select value={form.rewritePolicy} onChange={(e) => update('rewritePolicy', e.target.value)}>
              {['结构模仿', '话题模仿', '仅参考'].map((item) => <option key={item}>{item}</option>)}
            </select></label>
            <label className="wide">适合人设关键词<input placeholder="例如：成都,上班族,起号期。留空表示全部适合" value={form.suitableText} onChange={(e) => update('suitableText', e.target.value)} /></label>
            <label className="wide">禁用人设关键词<input placeholder="例如：自由职业,收尾期。命中则不批量生成" value={form.forbiddenText} onChange={(e) => update('forbiddenText', e.target.value)} /></label>
            <label className="wide">分析结论<textarea placeholder="补结构、适合账号和下一步建议" value={form.hotStructure} onChange={(e) => update('hotStructure', e.target.value)} /></label>
          </>
        )}
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={submit}>{isEditing ? '保存分析' : '记录链接'}</button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="modalBackdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="sectionHead"><h2>{title}</h2><button onClick={onClose}>关闭</button></div>
        {children}
      </div>
    </div>
  );
}

function personaText(persona = {}) {
  return [persona.city, persona.age ? `${persona.age}岁` : '', persona.occupation, persona.tone].filter(Boolean).join(' · ') || '未填写人设';
}

createRoot(document.getElementById('root')).render(<App />);
