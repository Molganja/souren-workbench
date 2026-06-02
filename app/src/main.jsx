import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const STAGES = ['起号期', '决策期', '术后恢复期', '成果期', '收尾期'];
const KINDS = ['素人种草', '日常养号', '爆款提权'];
const API = '/api';
const RANDOM_CASE_PROFILES = {
  cities: ['成都', '杭州', '重庆', '西安', '长沙', '武汉', '南京', '苏州', '广州', '深圳'],
  ages: [23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
  occupations: ['上班族', '自由职业', '美业顾问', '行政', '设计师', '护士', '教师', '运营', '店员', '宝妈'],
  tones: ['自然', '轻松', '克制', '真实记录', '生活化', '碎碎念'],
  motivations: ['想把状态变化记录下来', '想做一点真实生活记录', '想看看自己坚持更新后的变化', '想把纠结和决策过程讲清楚', '想用普通人的方式记录恢复过程']
};
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
  pending: '待核对',
  checking: '核对中',
  verified: '已核对',
  mismatch: '不匹配',
  not_found: '未找到',
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
  if (['已派发', '已汇报'].includes(status)) return 'report';
  if (['已核对'].includes(status)) return 'ok';
  if (['素材阻塞', '异常'].includes(status)) return 'bad';
  if (['waiting_key', 'draft', 'waiting_edit', 'pending', 'unavailable'].includes(status)) return 'wait';
  if (['generating', 'review', 'checking'].includes(status)) return 'report';
  if (['approved', 'completed', 'verified'].includes(status)) return 'ok';
  if (['rejected', 'mismatch', 'not_found', 'error', 'timeout', 'unknown'].includes(status)) return 'bad';
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

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function randomCaseDefaults() {
  const city = pickRandom(RANDOM_CASE_PROFILES.cities);
  const occupation = pickRandom(RANDOM_CASE_PROFILES.occupations);
  return {
    weixinNick: `${city}${occupation}${Math.floor(10 + Math.random() * 90)}`,
    persona: {
      city,
      age: pickRandom(RANDOM_CASE_PROFILES.ages),
      occupation,
      tone: pickRandom(RANDOM_CASE_PROFILES.tones),
      motivation: pickRandom(RANDOM_CASE_PROFILES.motivations)
    }
  };
}

function AccessGate({ session, onLogin }) {
  const [accessCode, setAccessCode] = useState('');
  return (
    <section className="hero accessGate">
      <div>
        <p className="eyebrow">局域网工作台</p>
        <h1>输入访问码</h1>
        <p>这个页面用于同局域网电脑访问主机工作台。通过后可以处理兼职对接、复制交付内容和回填任务状态。</p>
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
  const [contentSeeds, setContentSeeds] = useState([]);
  const [config, setConfig] = useState(null);
  const [session, setSession] = useState(null);
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [caseFormOpen, setCaseFormOpen] = useState(false);
  const [bulkCaseOpen, setBulkCaseOpen] = useState(false);
  const [viralFormOpen, setViralFormOpen] = useState(false);
  const [editingViral, setEditingViral] = useState(null);
  const [seedFormOpen, setSeedFormOpen] = useState(false);
  const [verifyTaskOpen, setVerifyTaskOpen] = useState(null);
  const [deliverySlotOpen, setDeliverySlotOpen] = useState(null);

  async function refresh() {
    const [dash, reviewData, scheduleData, caseRows, viralRows, seedRows, configData] = await Promise.all([
      request('/dashboard'),
      request('/review'),
      request('/schedule'),
      request('/cases'),
      request('/viral-templates'),
      request('/content-seeds'),
      request('/config')
    ]);
    setDashboard(dash);
    setReview(reviewData);
    setSchedule(scheduleData);
    setCases(caseRows);
    setViralTemplates(viralRows);
    setContentSeeds(seedRows);
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
      <button className={view === 'cases' ? 'active' : ''} onClick={() => setView('cases')}>案例库</button>
      <button className={view === 'viral' ? 'active' : ''} onClick={() => setView('viral')}>爆款链接</button>
      <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>系统配置</button>
    </div>
  );
  const canUseWorkbench = session ? (!session.authRequired || session.authenticated) : false;
  const canOpenLocalPaths = Boolean(session?.canOpenLocalPaths);

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
          <Dashboard data={dashboard} onOpenCase={openCase} onAct={act} onCopy={copyText} onOpenViral={() => setView('viral')} onVerify={setVerifyTaskOpen} onDelivery={setDeliverySlotOpen} canOpenLocalPaths={canOpenLocalPaths} />
        )}
        {!loading && canUseWorkbench && view === 'review' && review && (
          <ReviewView data={review} onOpenCase={openCase} />
        )}
        {!loading && canUseWorkbench && view === 'schedule' && schedule && (
          <ScheduleView data={schedule} onOpenCase={openCase} onAct={act} onCopy={copyText} onVerify={setVerifyTaskOpen} onDelivery={setDeliverySlotOpen} canOpenLocalPaths={canOpenLocalPaths} />
        )}
        {!loading && canUseWorkbench && view === 'cases' && (
          <CasesView cases={cases} onOpenCase={openCase} onNew={() => setCaseFormOpen(true)} onBulk={() => setBulkCaseOpen(true)} onAct={act} />
        )}
        {!loading && canUseWorkbench && view === 'case' && caseDetail && (
          <CaseDetail detail={caseDetail} onAct={act} onCopy={copyText} onBack={() => setView('cases')} onVerify={setVerifyTaskOpen} onDelivery={setDeliverySlotOpen} canOpenLocalPaths={canOpenLocalPaths} />
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
            onCopy={copyText}
          />
        )}
        {!loading && canUseWorkbench && view === 'seeds' && (
          <SeedView seeds={contentSeeds} onNew={() => setSeedFormOpen(true)} onAct={act} />
        )}
        {!loading && canUseWorkbench && view === 'settings' && config && (
          <SettingsView config={config} onAct={act} onCopy={copyText} canOpenLocalPaths={canOpenLocalPaths} />
        )}
      </main>
      {caseFormOpen && (
        <CaseForm
          onClose={() => setCaseFormOpen(false)}
          onSubmit={(payload) => act(async () => {
            const created = await request('/cases', { method: 'POST', body: JSON.stringify({ ...payload, generateSlots: true, days: 14 }) });
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
      {seedFormOpen && (
        <SeedForm
          onClose={() => setSeedFormOpen(false)}
          onSubmit={(payload) => act(async () => {
            await request('/content-seeds', { method: 'POST', body: JSON.stringify(payload) });
            setSeedFormOpen(false);
          }, '内容种子已保存')}
        />
      )}
      {verifyTaskOpen && (
        <VerifyForm
          task={verifyTaskOpen}
          onClose={() => setVerifyTaskOpen(null)}
          onSubmit={(payload) => act(async () => {
            await request(`/verify-tasks/${verifyTaskOpen.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
            setVerifyTaskOpen(null);
          }, payload.status === 'verified' ? '已核对并回填数据' : '核对结果已记录')}
        />
      )}
      {deliverySlotOpen && (
        <DeliveryModal
          slot={deliverySlotOpen}
          onClose={() => setDeliverySlotOpen(null)}
          onAct={act}
          onCopy={copyText}
          canOpenLocalPaths={canOpenLocalPaths}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Dashboard({ data, onOpenCase, onAct, onCopy, onOpenViral, onVerify, onDelivery, canOpenLocalPaths }) {
  const contactGroups = groupTodayByContact(data.todaySlots);
  const flowGroups = buildTodayFlow(data.todaySlots);
  const beginnerSteps = buildBeginnerSteps(data);
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">今日 {data.today}</p>
          <h1>运营中控台</h1>
          <p>先处理待生成、待选择和待交付，再核对兼职回传。这里按 40+ 账号的日常动作聚合，不需要逐个翻案例。</p>
          <div className="heroActions">
            <button className="primary" onClick={() => onAct(
              () => request('/dashboard/prepare-today', { method: 'POST' }),
              (result) => `已准备：生成 ${result.generatedCount}，锁定 ${result.selectedCount}，交付 ${result.deliveryCount}`
            )}>一键准备今日交付</button>
            <button onClick={() => onAct(
              () => request('/dashboard/generate-today', { method: 'POST' }),
              (result) => `已生成：槽位 ${result.slotCount}，候选 ${result.candidateCount}`
            )}>批量生成今日候选</button>
            <button onClick={() => onAct(
              () => request('/dashboard/deliver-today', { method: 'POST' }),
              (result) => `已生成交付内容：${result.deliveryCount}`
            )}>批量生成今日交付内容</button>
              <button onClick={() => copyOperatorPacket(onCopy)}>复制助手工作包</button>
              <button onClick={() => askLocalAi(onAct)}>请本地助手建议</button>
          </div>
        </div>
        <div className="stats">
          <Metric label="案例" value={data.counts.cases} />
          <Metric label="待生成" value={data.counts.pendingGenerate} />
          <Metric label="待选择" value={data.counts.pendingChoose} />
          <Metric label="待交付" value={data.counts.readyDelivery} />
          <Metric label="等回传" value={data.counts.sentWaitReport} />
          <Metric label="待核对" value={data.counts.pendingVerify} />
          <Metric label="阻塞" value={data.counts.blocked || 0} />
          <Metric label="必补素材" value={data.counts.requiredMaterialGaps || 0} />
          <Metric label="图片任务" value={data.counts.imageTasks || 0} />
          <Metric label="剪辑任务" value={data.counts.clipTasks || 0} />
          <Metric label="待爆款" value={data.counts.pendingViral || 0} />
        </div>
      </section>

      <section className="panel beginnerPanel">
        <div className="sectionHead">
          <h2>新手今日顺序</h2>
          <span>{beginnerSteps.filter((item) => item.count > 0).length} 个动作</span>
        </div>
        <div className="beginnerGrid">
          {beginnerSteps.map((step, index) => (
            <div className={`beginnerStep ${step.count > 0 ? 'active' : ''}`} key={step.title}>
              <strong>{index + 1}. {step.title}</strong>
              <span>{step.count > 0 ? `${step.count} 条` : '暂无'}</span>
              <small>{step.note}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="sectionHead">
          <h2>今日对接清单</h2>
          <div className="headerActions">
            <span>{contactGroups.length} 个对接人</span>
            {contactGroups.length > 0 && (
              <button onClick={() => onCopy(buildContactChecklist(data.today, contactGroups), '今日对接清单已复制')}>复制清单</button>
            )}
            {data.todaySlots.length > 0 && (
              <button onClick={() => onCopy(buildDailyBrief(data.today, contactGroups, flowGroups), '今日工作简报已复制')}>复制简报</button>
            )}
          </div>
        </div>
        {contactGroups.length === 0 ? <div className="empty">今天没有需要对接的任务</div> : (
          <div className="contactGrid">
            {contactGroups.map((group) => (
              <div className="contactCard" key={group.name}>
                <strong>{group.name}</strong>
                <span>{group.items.length} 条任务 · {contactStatusSummary(group)}</span>
                <small>{group.items.slice(0, 6).map((slot) => `${slot.case?.weixinNick || '未命名'}-${slot.contentKind}-${slot.status}`).join(' / ')}</small>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="sectionHead">
          <h2>今日链路复盘</h2>
          <span>{data.todaySlots.length} 条任务</span>
        </div>
        {data.todaySlots.length === 0 ? <div className="empty">今天没有链路数据</div> : (
          <div className="flowGrid">
            {flowGroups.map((group) => (
              <div className="flowCard" key={group.status}>
                <div className="rowTitle">
                  <span className={`status ${statusClass(group.status)}`}>{group.status}</span>
                  <strong>{group.items.length}</strong>
                </div>
                <small>{group.action}</small>
                {group.items.slice(0, 3).map((slot) => (
                  <button key={slot.id} className="flowItem" onClick={() => onOpenCase(slot.case?.id)}>
                    <span>{slot.case?.weixinNick || '未命名兼职'}</span>
                    <em>{slot.case?.staff || '未填对接人'} · {slot.contentKind}</em>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <TaskSection title="今天要处理" items={data.todaySlots} empty="今天没有到期任务" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} onVerify={onVerify} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} />
      <TaskSection title="待生成候选稿" items={data.pendingGenerate} empty="没有待生成内容" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} onVerify={onVerify} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} />
      <TaskSection title="待选择候选" items={data.pendingChoose} empty="没有待选择内容" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} onVerify={onVerify} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} />
      <TaskSection title="可微信交付" items={data.readyDelivery} empty="没有可交付任务" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} onVerify={onVerify} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} />
      <TaskSection title="待抖音核对" items={data.pendingVerify} empty="没有待核对任务" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} onVerify={onVerify} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} />
      <PendingViralSection items={data.pendingViralTemplates || []} onCopy={onCopy} onOpenViral={onOpenViral} />
      <ImageTaskSection items={data.imageTasks || []} onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} />
      <ClipTaskSection items={data.clipTasks || []} onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} canOpenLocalPaths={canOpenLocalPaths} />
      <AiConsultSection items={data.aiConsults || []} onAct={onAct} canOpenLocalPaths={canOpenLocalPaths} />

      <section className="panel">
        <div className="sectionHead">
          <h2>异常账号</h2>
          <span>{data.abnormalCases.length} 个</span>
        </div>
        {data.abnormalCases.length === 0 ? (
          <div className="empty">暂无异常账号</div>
        ) : (
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
        )}
      </section>
    </div>
  );
}

function PendingViralSection({ items, onCopy, onOpenViral }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>待爆款分析</h2>
        <div className="headerActions">
          <span>{items.length} 条</span>
          <button onClick={onOpenViral}>去粘贴链接</button>
        </div>
      </div>
      {items.length === 0 ? <div className="empty">没有待青豆分析的爆款链接</div> : (
        <div className="taskList">
          {items.map((item) => (
            <div className="taskRow" key={item.id}>
              <div className="taskMain">
                <div className="rowTitle">
                  <strong>{item.title}</strong>
                  <span className="status s-pending">待青豆分析</span>
                </div>
                <p>{item.hotStructure}</p>
                {item.sourceLink && <small>{item.sourceLink}</small>}
              </div>
              <div className="rowActions">
                {item.sourceLink && <a className="button" href={item.sourceLink} target="_blank">打开原链接</a>}
                <button onClick={() => copyQingdouTask(item, onCopy)}>复制青豆任务</button>
                <button onClick={onOpenViral}>补分析结果</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ImageTaskSection({ items, onOpenCase, onAct, onCopy }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>待图片处理</h2>
        <span>{items.length} 条</span>
      </div>
      {items.length === 0 ? <div className="empty">没有待处理图片任务</div> : (
        <div className="taskList">
          {items.map((task) => (
            <div className="taskRow" key={task.id}>
              <div className="taskMain">
                <div className="rowTitle">
                  <button className="linkButton" onClick={() => task.case?.id && onOpenCase(task.case.id)}>{task.case?.weixinNick || '未知账号'}</button>
                  <span className={`status ${statusClass(task.status)}`}>{displayStatus(task.status)}</span>
                </div>
                <p>{task.purpose}</p>
                <small>{task.prompt}</small>
                <GeneratedImageStrip files={task.generatedFiles || []} />
              </div>
              <div className="rowActions">
                <button onClick={() => copyImagePrompt(task, onCopy)}>复制图片提示词</button>
                <button onClick={() => generateImageTask(task, onAct)}>生成图片</button>
                {REVIEW_ACTIONS.map(([status, label]) => (
                  <button key={status} onClick={() => onAct(() => request(`/image-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), `图片任务已标记：${displayStatus(status)}`)}>{label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ClipTaskSection({ items, onOpenCase, onAct, onCopy, canOpenLocalPaths }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>待剪辑处理</h2>
        <span>{items.length} 条</span>
      </div>
      {items.length === 0 ? <div className="empty">没有待处理剪辑任务</div> : (
        <div className="taskList">
          {items.map((task) => (
            <div className="taskRow" key={task.id}>
              <div className="taskMain">
                <div className="rowTitle">
                  <button className="linkButton" onClick={() => task.case?.id && onOpenCase(task.case.id)}>{task.case?.weixinNick || '未知账号'}</button>
                  <span className={`status ${statusClass(task.status)}`}>{displayStatus(task.status)}</span>
                </div>
                <p>{task.title}</p>
                <small>{task.outputDir}</small>
              </div>
              <div className="rowActions">
                <button onClick={() => onCopy(task.brief, '剪辑任务单已复制')}>复制任务单</button>
                {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: task.outputDir }) }), '已打开剪辑目录')}>打开目录</button>}
                {CLIP_ACTIONS.map(([status, label]) => (
                  <button key={status} onClick={() => onAct(() => request(`/clip-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), `剪辑任务已标记：${displayStatus(status)}`)}>{label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AiConsultSection({ items, onAct, canOpenLocalPaths }) {
  return (
    <section className="panel">
      <div className="sectionHead">
          <h2>本地助手建议记录</h2>
        <span>{items.length} 条</span>
      </div>
      {items.length === 0 ? <div className="empty">还没有本地助手建议记录</div> : (
        <div className="taskList">
          {items.map((item) => (
            <div className="consultRow" key={item.path}>
              <div>
                <div className="rowTitle">
                  <span className={`status ${consultStatusClass(item.status)}`}>{displayStatus(item.status)}</span>
                  <strong>{formatDateTime(item.createdAt)}</strong>
                  <small>{item.command}</small>
                </div>
                <pre>{item.summary}</pre>
                <small>{item.path}</small>
              </div>
              <div className="rowActions">
                {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: item.path }) }), '已打开顾问记录')}>打开记录</button>}
                {canOpenLocalPaths && item.packetPath && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: item.packetPath }) }), '已打开工作包')}>打开工作包</button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function consultStatusClass(status) {
  if (status === 'completed') return 's-ok';
  if (status === 'unavailable') return 's-pending';
  return 's-bad';
}

function formatDateTime(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 16);
}

function groupTodayByContact(slots) {
  const groups = new Map();
  slots.forEach((slot) => {
    const name = slot.case?.staff || '未填对接人';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(slot);
  });
  return Array.from(groups, ([name, items]) => ({
    name,
    items,
    pendingGenerate: items.filter((slot) => slot.status === '待生成').length,
    pendingChoose: items.filter((slot) => slot.status === '候选待选').length,
    locked: items.filter((slot) => slot.status === '已锁定').length,
    blocked: items.filter((slot) => slot.status === '素材阻塞').length,
    readyDelivery: items.filter((slot) => slot.status === '可交付').length,
    sentWaitReport: items.filter((slot) => slot.status === '已派发').length,
    pendingVerify: items.filter((slot) => slot.status === '已汇报').length,
    verified: items.filter((slot) => slot.status === '已核对').length
  }))
    .sort((a, b) => b.items.length - a.items.length);
}

function contactStatusSummary(group) {
  return [
    ['待生成', group.pendingGenerate],
    ['待选', group.pendingChoose],
    ['已锁定', group.locked],
    ['阻塞', group.blocked],
    ['可交付', group.readyDelivery],
    ['等回传', group.sentWaitReport],
    ['待核对', group.pendingVerify],
    ['已核对', group.verified]
  ]
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`)
    .join(' · ') || '暂无待办';
}

function buildContactChecklist(date, groups) {
  const lines = [`${date} 今日对接清单`];
  groups.forEach((group) => {
    lines.push('', `【${group.name}】${group.items.length} 条`);
    group.items.forEach((slot, index) => {
      const caze = slot.case || {};
      lines.push([
        `${index + 1}. 发给：${caze.weixinNick || '未命名兼职'}`,
        `账号：${caze.douyinId || '未填抖音号'}`,
        `内容：${slot.contentKind}`,
        `状态：${slot.status}`,
        `动作：${nextActionText(slot)}`
      ].join('｜'));
      if (slot.deliveryDir) lines.push('   交付内容：系统内点“查看交付内容”复制文案和下载素材');
    });
  });
  return lines.join('\n');
}

const TODAY_FLOW = [
  ['待生成', '系统生成 3 条候选稿'],
  ['候选待选', '运营选择一条锁定'],
  ['已锁定', '系统生成微信交付内容'],
  ['素材阻塞', '补素材或创建图片/剪辑任务'],
  ['可交付', '复制文案和素材发微信'],
  ['已派发', '等待兼职回传作品链接'],
  ['已汇报', '打开抖音核对并回填数据'],
  ['已核对', '进入账号复盘']
];

function buildTodayFlow(slots) {
  return TODAY_FLOW
    .map(([status, action]) => ({
      status,
      action,
      items: slots.filter((slot) => slot.status === status)
    }))
    .filter((group) => group.items.length > 0);
}

function buildBeginnerSteps(data) {
  const counts = data.counts || {};
  return [
    {
      title: '生成今天内容',
      count: counts.pendingGenerate || 0,
      note: '先让系统给待生成槽位出 3 条候选稿。'
    },
    {
      title: '挑一条锁定',
      count: counts.pendingChoose || 0,
      note: '从候选里选最适合这个账号人设的一条。'
    },
    {
      title: '处理素材缺口',
      count: (counts.blocked || 0) + (counts.requiredMaterialGaps || 0),
      note: '缺素材时复制补素材说明，或创建图片/剪辑任务。'
    },
    {
      title: '微信交付',
      count: counts.readyDelivery || 0,
      note: '查看交付内容，复制文案，下载图片或视频发给兼职。'
    },
    {
      title: '剪辑任务',
      count: counts.clipTasks || 0,
      note: '复制任务单，剪完或安排发布后标记完成。'
    },
    {
      title: '核对回填',
      count: counts.pendingVerify || 0,
      note: '打开抖音链接，回填播放、点赞、评论和粉丝。'
    }
  ];
}

function buildDailyBrief(date, contactGroups, flowGroups) {
  const lines = [`${date} 今日工作简报`];
  lines.push('', '【链路统计】');
  flowGroups.forEach((group) => {
    lines.push(`${group.status}：${group.items.length}｜${group.action}`);
  });
  lines.push('', '【按对接人】');
  contactGroups.forEach((group) => {
    lines.push(`${group.name}：${group.items.length} 条｜可交付 ${group.readyDelivery}｜等回传 ${group.sentWaitReport}｜待核对 ${group.pendingVerify}`);
    group.items.forEach((slot, index) => {
      const caze = slot.case || {};
      lines.push(`  ${index + 1}. 发给 ${caze.weixinNick || '未命名兼职'}｜账号 ${caze.douyinId || '未填抖音号'}｜${slot.contentKind}｜${slot.status}｜${nextActionText(slot)}`);
      if (slot.deliveryDir) lines.push('     交付内容：系统内点“查看交付内容”复制文案和下载素材');
    });
  });
  return lines.join('\n');
}

function nextActionText(slot) {
  if (slot.status === '待生成') return '生成候选稿';
  if (slot.status === '候选待选') return '选择一条候选';
  if (slot.status === '已锁定') return '生成交付内容';
  if (slot.status === '素材阻塞') return '补素材后重新生成交付内容';
  if (slot.status === '可交付') return '复制文案和素材发微信';
  if (slot.status === '已派发') return '等待兼职回传';
  if (slot.status === '已汇报') return '打开抖音核对';
  if (slot.status === '已核对') return '进入账号复盘';
  return '查看任务';
}

function ReviewView({ data, onOpenCase }) {
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">复盘 {data.today}</p>
          <h1>账号表现和运营复盘</h1>
          <p>把排期进度、交付、核对、素材和账号数据放在一起看，用来决定下一轮是补养号、加爆款提权，还是推进种草内容。</p>
        </div>
        <div className="stats reviewStats">
          <Metric label="总排期" value={data.totals.slots} />
          <Metric label="已派发" value={data.totals.sent} />
          <Metric label="已核对" value={data.totals.verified} />
          <Metric label="可用素材" value={data.totals.usableAssets} />
          <Metric label="待图片接口" value={data.totals.imageWaitingKey} />
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
          <div className="sectionHead"><h2>生命周期分布</h2><span>{data.totals.cases} 个案例</span></div>
          <div className="reviewGrid">
            {data.stageStats.map((item) => (
              <div className="reviewCard compact" key={item.stage}>
                <strong>{item.stage}</strong>
                <small>{item.cases} 个账号 · {item.slots} 个排期</small>
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
                <span>{item.caseCode} · {item.project} · {item.stage}</span>
                <em>{[...item.reasons, item.pendingVerify ? `待核对 ${item.pendingVerify}` : '', item.materialGaps ? `素材缺口 ${item.materialGaps}` : ''].filter(Boolean).join(' / ')}</em>
                {item.actions?.[0] && <small>{item.actions[0]}</small>}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="sectionHead"><h2>播放表现前列</h2><span>{data.topAccounts.length} 个</span></div>
        {data.topAccounts.length === 0 ? <div className="empty">核对并回填数据后，这里会按播放排序</div> : (
          <div className="metricTable">
            <div className="metricHeader reviewMetricHeader"><span>账号</span><span>日期</span><span>粉丝</span><span>播放</span><span>点赞</span><span>评论</span><span>变化</span></div>
            {data.topAccounts.map((item) => (
              <div className="metricLine reviewMetricLine" key={item.id}>
                <button className="linkButton" onClick={() => onOpenCase(item.id)}>{item.weixinNick}</button>
                <span>{item.latestMetric.date}</span>
                <span>{item.latestMetric.fans ?? '—'}</span>
                <span>{item.latestMetric.plays ?? '—'}</span>
                <span>{item.latestMetric.likes ?? '—'}</span>
                <span>{item.latestMetric.comments ?? '—'}</span>
                <span>{item.delta ? `粉丝 ${signed(item.delta.fans)} / 播放 ${signed(item.delta.plays)}` : '首次记录'}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="sectionHead"><h2>最近回填数据</h2><span>{data.recentMetrics.length} 条</span></div>
        {data.recentMetrics.length === 0 ? <div className="empty">暂无账号数据</div> : (
          <div className="metricTable">
            <div className="metricHeader reviewMetricHeader"><span>账号</span><span>日期</span><span>粉丝</span><span>播放</span><span>点赞</span><span>评论</span><span>备注</span></div>
            {data.recentMetrics.map((item) => (
              <div className="metricLine reviewMetricLine" key={item.id}>
                <button className="linkButton" onClick={() => item.case && onOpenCase(item.case.id)}>{item.case?.weixinNick || '未知账号'}</button>
                <span>{item.date}</span>
                <span>{item.fans ?? '—'}</span>
                <span>{item.plays ?? '—'}</span>
                <span>{item.likes ?? '—'}</span>
                <span>{item.comments ?? '—'}</span>
                <span>{item.note || '—'}</span>
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

function caseContactLine(caze = {}) {
  return [
    caze.caseCode || caze.douyinId || '未建案例',
    caze.staff ? `对接：${caze.staff}` : '未填对接人'
  ].filter(Boolean).join(' · ');
}

function ScheduleView({ data, onOpenCase, onAct, onCopy, onVerify, onDelivery, canOpenLocalPaths }) {
  const [range, setRange] = useState('14');
  const [status, setStatus] = useState('全部状态');
  const [kind, setKind] = useState('全部内容');
  const [query, setQuery] = useState('');
  const endDate = addDaysLocal(data.today, Number(range));
  const filtered = data.slots.filter((slot) => {
    const caze = slot.case || {};
    const q = query.trim().toLowerCase();
    const haystack = `${caze.weixinNick || ''} ${caze.caseCode || ''} ${caze.douyinId || ''} ${caze.staff || ''} ${slot.goal}`.toLowerCase();
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
          <p>按日期查看所有兼职/账号未来要发什么，集中处理待生成、待选择、待交付和待核对。</p>
        </div>
        <div className="stats reviewStats">
          <Metric label="总排期" value={data.counts.total} />
          <Metric label="待生成" value={data.counts.pendingGenerate} />
          <Metric label="待选择" value={data.counts.pendingChoose} />
          <Metric label="已锁定" value={data.counts.locked} />
          <Metric label="待核对" value={data.counts.pendingVerify} />
        </div>
      </section>
      <section className="panel">
        <div className="filters scheduleFilters">
          <input placeholder="搜索账号 / 抖音号 / 案例编号 / 对接人 / 目标" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="7">未来 7 天</option>
            <option value="14">未来 14 天</option>
            <option value="30">未来 30 天</option>
            <option value="60">未来 60 天</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['全部状态', '待生成', '候选待选', '已锁定', '素材阻塞', '可交付', '已派发', '已汇报', '已核对', '异常'].map((item) => <option key={item}>{item}</option>)}
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
              <ScheduleRow key={slot.id} slot={slot} onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} onVerify={onVerify} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ScheduleRow({ slot, onOpenCase, onAct, onCopy, onVerify, onDelivery, canOpenLocalPaths }) {
  const caze = slot.case || {};
  const douyinUrl = slot.verifyTask?.douyinUrl || caze.douyinUrl;
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
        <small>{caseContactLine(caze)} · 候选 {slot.candidateCount}</small>
      </div>
      <div className="rowActions">
        {slot.status === '待生成' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/generate-candidates`, { method: 'POST' }), '已生成候选')}>生成候选</button>}
        {['已锁定', '素材阻塞'].includes(slot.status) && <button onClick={() => onAct(() => generateDeliveryAndOpen(slot, onDelivery), (result) => result.blocked ? '缺少素材，已打开阻塞说明' : '交付内容已生成')}>生成交付内容</button>}
        {slot.deliveryDir && <button onClick={() => onDelivery(slot)}>查看交付内容</button>}
        {slot.status === '素材阻塞' && <button onClick={() => copyMaterialIntakeNote(caze, onCopy)}>复制补素材说明</button>}
        {canOpenLocalPaths && slot.status === '素材阻塞' && caze.localCaseDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.localCaseDir }) }), '已打开素材目录')}>打开素材目录</button>}
        {slot.selectedCandidate && <button onClick={() => onCopy(slot.selectedCandidate.operatorInstruction, '执行说明已复制')}>复制执行说明</button>}
        {slot.selectedCandidate && <button onClick={() => onCopy(`${slot.selectedCandidate.title}\n\n${slot.selectedCandidate.publishText}`, '发布文案已复制')}>复制发布文案</button>}
        {slot.status === '可交付' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) }), '已标记派发')}>标记派发</button>}
        {slot.status === '已派发' && <button onClick={() => markReported(slot, onAct)}>兼职已汇报</button>}
        {slot.status === '已汇报' && slot.verifyTask && <button onClick={() => copyVerifyChecklist(slot.verifyTask, onCopy)}>复制核对清单</button>}
        {slot.status === '已汇报' && slot.verifyTask && <button onClick={() => onVerify(slot.verifyTask)}>核对回填</button>}
        {slot.status === '已汇报' && douyinUrl && <a className="button" href={douyinUrl} target="_blank">打开抖音</a>}
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

function TaskSection({ title, items, empty, onOpenCase, onAct, onCopy, onVerify, onDelivery, canOpenLocalPaths }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>{title}</h2>
        <span>{items.length} 条</span>
      </div>
      {items.length === 0 ? <div className="empty">{empty}</div> : (
        <div className="taskList">
          {items.map((slot) => (
            <TaskRow key={slot.id} slot={slot} onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} onVerify={onVerify} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskRow({ slot, onOpenCase, onAct, onCopy, onVerify, onDelivery, canOpenLocalPaths }) {
  const caze = slot.case || {};
  const douyinUrl = slot.verifyTask?.douyinUrl || caze.douyinUrl;
  return (
    <div className="taskRow">
      <div className="dateBox">
        <strong>{slot.date.slice(5)}</strong>
        <span>{slot.timeWindow || '全天'}</span>
      </div>
      <div className="taskMain">
        <div className="rowTitle">
          <button className="linkButton" onClick={() => onOpenCase(caze.id)}>{caze.weixinNick || '未命名'}</button>
          <span className={`kind k-${slot.contentKind}`}>{slot.contentKind}</span>
          <span className={`status ${statusClass(slot.status)}`}>{slot.status}</span>
        </div>
        <p>{slot.goal}</p>
        <div className="deliveryMeta">
          <span>发给：{caze.weixinNick || '未命名兼职'}</span>
          <span>对接：{caze.staff || '未填对接人'}</span>
        </div>
        <small>{caseContactLine(caze)} · {slot.stage}</small>
      </div>
      <div className="rowActions">
        {slot.status === '待生成' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/generate-candidates`, { method: 'POST' }), '已生成 3 条候选')}>生成候选</button>}
        {['已锁定', '素材阻塞'].includes(slot.status) && <button onClick={() => onAct(() => generateDeliveryAndOpen(slot, onDelivery), (result) => result.blocked ? '缺少素材，已打开阻塞说明' : '交付内容已生成')}>生成交付内容</button>}
        {slot.deliveryDir && <button onClick={() => onDelivery(slot)}>查看交付内容</button>}
        {slot.status === '素材阻塞' && <button onClick={() => copyMaterialIntakeNote(caze, onCopy)}>复制补素材说明</button>}
        {canOpenLocalPaths && slot.status === '素材阻塞' && caze.localCaseDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.localCaseDir }) }), '已打开素材目录')}>打开素材目录</button>}
        {slot.selectedCandidate && <button onClick={() => onCopy(slot.selectedCandidate.operatorInstruction, '执行说明已复制')}>复制执行说明</button>}
        {slot.selectedCandidate && <button onClick={() => onCopy(`${slot.selectedCandidate.title}\n\n${slot.selectedCandidate.publishText}`, '发布文案已复制')}>复制发布文案</button>}
        {slot.status === '可交付' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) }), '已标记派发')}>标记派发</button>}
        {slot.status === '已派发' && <button onClick={() => markReported(slot, onAct)}>兼职已汇报</button>}
        {slot.status === '已汇报' && slot.verifyTask && <button onClick={() => copyVerifyChecklist(slot.verifyTask, onCopy)}>复制核对清单</button>}
        {slot.status === '已汇报' && slot.verifyTask && <button onClick={() => onVerify(slot.verifyTask)}>核对回填</button>}
        {slot.status === '已汇报' && douyinUrl && <a className="button" href={douyinUrl} target="_blank">打开抖音</a>}
      </div>
    </div>
  );
}

function markReported(slot, onAct) {
  const link = window.prompt('粘贴兼职回传的抖音作品链接；如果只有截图或还没拿到链接，可以留空。', slot.case?.douyinUrl || '');
  if (link === null) return;
  const note = link.trim() ? `兼职回传作品链接：${link.trim()}` : '兼职已汇报，待补作品链接或截图';
  onAct(
    () => request(`/slots/${slot.id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: '已汇报',
        douyinUrl: link.trim(),
        resultNote: note
      })
    }),
    '已进入待核对'
  );
}

function CasesView({ cases, onOpenCase, onNew, onBulk, onAct }) {
  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState('全部阶段');
  const [healthFilter, setHealthFilter] = useState('全部状态');
  const filtered = cases.filter((item) => {
    const q = query.trim().toLowerCase();
    const haystack = `${item.weixinNick} ${item.caseCode} ${item.douyinId} ${item.staff || ''} ${item.project} ${personaText(item.persona)}`.toLowerCase();
    const matchQuery = !q || haystack.includes(q);
    const matchStage = stageFilter === '全部阶段' || item.stage === stageFilter;
    const matchHealth = healthFilter === '全部状态' || item.healthStatus === healthFilter;
    return matchQuery && matchStage && matchHealth;
  });
  const healthOptions = ['全部状态', ...Array.from(new Set(cases.map((item) => item.healthStatus).filter(Boolean)))];
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>案例库</h2>
        <div className="inlineActions">
          <button onClick={onBulk}>批量导入</button>
          <button className="button primary" onClick={onNew}>新建案例</button>
        </div>
      </div>
      <div className="filters">
        <input placeholder="搜索微信昵称 / 抖音号 / 对接人 / 案例编号 / 项目 / 人设" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
          {['全部阶段', ...STAGES].map((item) => <option key={item}>{item}</option>)}
        </select>
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
                <span>{item.caseCode} · {item.project} · {item.stage}</span>
                <em>{item.douyinId || '未填抖音号'} · {item.staff ? `对接：${item.staff}` : '未填对接人'} · {item.healthStatus}</em>
              </button>
              <button className="dangerButton" onClick={() => deleteCase(item, onAct)}>删除</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function deleteCase(item, onAct) {
  if (!window.confirm(`删除案例「${item.weixinNick}」？数据库记录和本地素材目录都会删除，不能恢复。`)) return;
  onAct(() => request(`/cases/${item.id}`, { method: 'DELETE' }), (result) => result.removedDir ? '案例和本地素材目录已删除' : '案例已删除，本地目录原本不存在');
}

function CaseDetail({ detail, onAct, onCopy, onBack, onVerify, onDelivery, canOpenLocalPaths }) {
  const { case: caze, slots, candidates, assets, imageTasks, clipTasks = [], verifyTasks, metrics = [], materialGaps = [], healthReasons = [], healthActions = [] } = detail;
  const [editOpen, setEditOpen] = useState(false);
  const [slotFormOpen, setSlotFormOpen] = useState(false);
  const candidatesBySlot = useMemo(() => {
    const map = {};
    candidates.forEach((item) => {
      map[item.slotId] = map[item.slotId] || [];
      map[item.slotId].push(item);
    });
    return map;
  }, [candidates]);
  return (
    <div className="stack">
      <button className="back" onClick={onBack}>返回案例库</button>
      <section className="caseHeader">
        <div>
          <p className="eyebrow">{caze.caseCode}</p>
          <h1>{caze.weixinNick}</h1>
          <p>{caze.project} · {caze.stage} · {caze.staff ? `对接：${caze.staff}` : '未填对接人'} · {personaText(caze.persona)}</p>
          {healthReasons.length > 0 && <p className="healthLine">当前提示：{healthReasons.join(' / ')}</p>}
          {healthActions.length > 0 && <p className="healthLine">建议动作：{healthActions.join(' / ')}</p>}
          <p className="path">素材目录：{caze.localCaseDir}</p>
        </div>
        <div className="headerActions">
          <button onClick={() => setEditOpen(true)}>编辑案例</button>
          <button onClick={() => onAct(() => request(`/cases/${caze.id}/generate-slots`, { method: 'POST', body: JSON.stringify({ days: 30 }) }), '已补齐 30 天排期槽位')}>生成30天排期</button>
          <button onClick={() => setSlotFormOpen(true)}>手动加槽位</button>
          <button onClick={() => onAct(() => request(`/cases/${caze.id}/scan-assets`, { method: 'POST' }), '素材扫描完成')}>扫描素材</button>
          {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.localCaseDir }) }), '已打开案例目录')}>打开素材目录</button>}
          <button onClick={() => copyMaterialIntakeNote(caze, onCopy)}>复制补素材说明</button>
          {caze.douyinUrl && <a className="button" href={caze.douyinUrl} target="_blank">打开抖音主页</a>}
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
      {slotFormOpen && (
        <SlotForm
          caze={caze}
          onClose={() => setSlotFormOpen(false)}
          onSubmit={(payload) => onAct(async () => {
            await request(`/cases/${caze.id}/slots`, { method: 'POST', body: JSON.stringify(payload) });
            setSlotFormOpen(false);
          }, '槽位已新增')}
        />
      )}

      <section className="panel">
        <div className="sectionHead"><h2>内容排期</h2><span>{slots.length} 条</span></div>
        {slots.length === 0 ? <div className="empty">还没有排期槽位</div> : (
          <div className="slotList">
            {slots.map((slot) => (
              <SlotCard key={slot.id} slot={slot} candidates={candidatesBySlot[slot.id] || []} caze={caze} onAct={onAct} onCopy={onCopy} onDelivery={onDelivery} canOpenLocalPaths={canOpenLocalPaths} />
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
                  <span>{asset.stage} · {asset.source} · {asset.reviewStatus}</span>
                  <small>{asset.path}</small>
                  <div className="inlineActions">
                    {['可用', '需处理', '不可用'].map((status) => (
                      <button key={status} onClick={() => onAct(() => request(`/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify({ reviewStatus: status }) }), `素材已标记：${status}`)}>{status}</button>
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
            <button onClick={() => onAct(() => request('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, title: `${caze.weixinNick}临时剪辑任务` }) }), '剪辑任务已创建')}>新建剪辑任务</button>
          </div>
          {clipTasks.length === 0 ? <div className="empty">暂无剪辑任务</div> : (
            <div className="assetList">
              {clipTasks.map((task) => (
                <div className="assetRow" key={task.id}>
                  <strong>{task.title}</strong>
                  <span>{displayStatus(task.status)}</span>
                  <small>{task.outputDir}</small>
                  <div className="inlineActions">
                    <button onClick={() => onCopy(task.brief, '剪辑任务单已复制')}>复制任务单</button>
                    {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: task.outputDir }) }), '已打开剪辑目录')}>打开目录</button>}
                    {CLIP_ACTIONS.map(([status, label]) => (
                      <button key={status} onClick={() => onAct(() => request(`/clip-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), `剪辑任务已标记：${displayStatus(status)}`)}>{label}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="twoCol">
        <div className="panel">
          <div className="sectionHead">
            <h2>图片任务</h2>
            <button onClick={() => onAct(() => request('/image-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, purpose: '日常养号' }) }), '图片任务已创建')}>新建图片任务</button>
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
                    <button onClick={() => copyImagePrompt(task, onCopy)}>复制图片提示词</button>
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
        <div className="sectionHead"><h2>核对队列</h2><span>{verifyTasks.length} 条</span></div>
        {verifyTasks.length === 0 ? <div className="empty">兼职汇报后会自动进入核对队列</div> : (
          <div className="taskList">
            {verifyTasks.map((task) => (
              <div className="taskRow" key={task.id}>
                <div className="taskMain">
                  <div className="rowTitle"><strong>{task.expectedTitle || '待核对内容'}</strong><span className={`status ${statusClass(task.status)}`}>{displayStatus(task.status)}</span></div>
                  <p>{task.expectedPublishDate} · 预期素材 {task.expectedAssets?.length || 0} 个 · {task.resultNote || '等待打开抖音核对'}</p>
                </div>
                <div className="rowActions">
                  {task.douyinUrl && <a className="button" href={task.douyinUrl} target="_blank">打开抖音</a>}
                  <button onClick={() => copyVerifyChecklist(task, onCopy)}>复制核对清单</button>
                  <button onClick={() => onVerify(task)}>核对回填</button>
                  <button onClick={() => onAct(() => request(`/verify-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'mismatch', resultNote: '内容或发布时间不匹配' }) }), '已标记异常')}>异常</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="sectionHead"><h2>账号数据</h2><span>{metrics.length} 条</span></div>
        {metrics.length === 0 ? <div className="empty">核对并回填后，这里会显示粉丝、播放、点赞、评论记录</div> : (
          <div className="metricTable">
            <div className="metricHeader"><span>日期</span><span>粉丝</span><span>播放</span><span>点赞</span><span>评论</span><span>备注</span></div>
            {metrics.map((item, index) => {
              const prev = metrics[index + 1];
              const fanDelta = prev?.fans != null && item.fans != null ? item.fans - prev.fans : null;
              return (
                <div className="metricLine" key={item.id}>
                  <span>{item.date}</span>
                  <span>{item.fans ?? '—'} {fanDelta != null && <em>{fanDelta >= 0 ? `+${fanDelta}` : fanDelta}</em>}</span>
                  <span>{item.plays ?? '—'}</span>
                  <span>{item.likes ?? '—'}</span>
                  <span>{item.comments ?? '—'}</span>
                  <span>{item.note || '—'}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

async function copyMaterialIntakeNote(caze, onCopy) {
  const result = await request(`/cases/${caze.id}/material-intake-note`);
  onCopy(result.text, '补素材说明已复制');
}

async function copyImagePrompt(task, onCopy) {
  const result = await request(`/image-tasks/${task.id}/prompt`);
  onCopy(result.text, '图片提示词已复制');
}

async function generateImageTask(task, onAct) {
  await onAct(
    () => request(`/image-tasks/${task.id}/generate`, { method: 'POST' }),
    (result) => `图片已生成 ${result.files?.length || 0} 张，等待审核`
  );
}

async function copyVerifyChecklist(task, onCopy) {
  const result = await request(`/verify-tasks/${task.id}/checklist`);
  onCopy(result.text, '核对清单已复制');
}

async function copyOperatorPacket(onCopy) {
  const result = await request('/dashboard/operator-packet', { method: 'POST' });
  onCopy(result.text, '助手工作包已复制并保存');
}

async function askLocalAi(onAct) {
  await onAct(
    () => request('/dashboard/ai-consult', { method: 'POST' }),
    (result) => {
      if (result.status === 'completed') return '本地助手建议已保存';
      if (result.status === 'unavailable') return '未找到本地助手命令，已保存工作包';
      if (result.status === 'timeout') return '本地助手调用超时，已保存记录';
      return '本地助手调用失败，已保存记录';
    }
  );
}

function SlotCard({ slot, candidates, caze, onAct, onCopy, onDelivery, canOpenLocalPaths }) {
  const selected = candidates.find((item) => item.selected);
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
        {!selected && ['待生成', '候选待选', '素材阻塞', '异常'].includes(slot.status) && (
          <button onClick={() => onAct(() => request(`/slots/${slot.id}/generate-candidates`, { method: 'POST' }), '已生成候选')}>生成/重 roll</button>
        )}
        {selected && <button onClick={() => onAct(() => generateDeliveryAndOpen({ ...slot, case: caze }, onDelivery), (result) => result.blocked ? '缺少素材，已打开阻塞说明' : '交付内容已生成')}>生成交付内容</button>}
        {selected && <button onClick={() => onAct(() => request('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, planSlotId: slot.id, title: `${slot.date}_${slot.contentKind}_剪辑任务` }) }), '剪辑任务已创建')}>创建剪辑任务</button>}
        {slot.deliveryDir && <button onClick={() => onDelivery({ ...slot, case: caze })}>查看交付内容</button>}
        {slot.status === '素材阻塞' && <button onClick={() => copyMaterialIntakeNote(caze, onCopy)}>复制补素材说明</button>}
        {canOpenLocalPaths && slot.status === '素材阻塞' && caze.localCaseDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.localCaseDir }) }), '已打开素材目录')}>打开素材目录</button>}
        {slot.status === '可交付' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) }), '已派发')}>标记派发</button>}
        {slot.status === '已派发' && <button onClick={() => markReported({ ...slot, case: caze }, onAct)}>兼职已汇报</button>}
        {slot.status !== '已核对' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '异常' }) }), '已标记异常')}>异常</button>}
      </div>
      {slot.deliveryDir && <div className="path">交付内容已生成，可在网页内查看、复制和下载。</div>}
      {candidates.length > 0 && (
        <div className="draftGrid">
          {candidates.map((draft) => (
            <div className={`draft ${draft.selected ? 'selected' : ''}`} key={draft.id}>
              <div className="draftHead">
                <strong>{draft.variant}</strong>
                <span>{draft.format}</span>
              </div>
              <h3>{draft.title}</h3>
              <p>{draft.publishText}</p>
              <div className="inlineActions">
                <button onClick={() => onAct(() => request(`/candidates/${draft.id}/select`, { method: 'POST' }), '已锁定候选')}>{draft.selected ? '已选择' : '选择这条'}</button>
                <button onClick={() => onCopy(draft.operatorInstruction, '执行说明已复制')}>复制执行说明</button>
                <button onClick={() => onCopy(`${draft.title}\n\n${draft.publishText}`, '发布文案已复制')}>复制发布文案</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveryModal({ slot, onClose, onAct, onCopy, canOpenLocalPaths }) {
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
  return (
    <Modal title="交付内容" onClose={onClose}>
      <div className="deliveryHeader">
        <div>
          <strong>发给：{view.case?.weixinNick || '未命名兼职'}</strong>
          <span>对接：{view.case?.staff || '未填对接人'}｜账号：{view.case?.douyinId || '未填抖音号'}｜{view.slot.contentKind}</span>
        </div>
        <span className={`status ${statusClass(view.slot.status)}`}>{view.slot.status}</span>
      </div>

      {texts.blockedNote && (
        <div className="textPanel warningPanel">
          <strong>素材阻塞说明</strong>
          <pre>{texts.blockedNote}</pre>
        </div>
      )}

      <div className="deliveryTextGrid">
        <TextPanel title="发给兼职文案" text={texts.operatorInstruction} onCopy={onCopy} />
        <TextPanel title="抖音发布文案" text={texts.publishText} onCopy={onCopy} />
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

      {texts.assetOrder && <TextPanel title="素材发送顺序" text={texts.assetOrder} onCopy={onCopy} />}
      {texts.publishRules && <TextPanel title="发布要求" text={texts.publishRules} onCopy={onCopy} />}

      {view.isVideo && (
        <section className="deliverySection">
          <div className="sectionHead"><h2>视频剪辑</h2><span>剪辑人员使用</span></div>
          <div className="deliveryTextGrid">
            <TextPanel title="口播/字幕文案" text={texts.voiceover} onCopy={onCopy} />
            <TextPanel title="剪辑要求" text={texts.editBrief} onCopy={onCopy} />
          </div>
          <div className="deliveryPaths">
            <div><strong>成片保存到</strong><span>{view.editing?.finalVideoPath}</span></div>
            <div><strong>封面保存到</strong><span>{view.editing?.coverPath}</span></div>
            <button onClick={() => onCopy(view.editing?.finalVideoPath || '', '成片保存路径已复制')}>复制成片路径</button>
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
        {view.slot.status === '可交付' && (
          <button className="primary" onClick={() => onAct(async () => {
            await request(`/slots/${view.slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) });
            onClose();
          }, '已标记派发')}>已用微信发送</button>
        )}
      </div>
    </Modal>
  );
}

function TextPanel({ title, text, onCopy }) {
  return (
    <div className="textPanel">
      <div className="rowTitle">
        <strong>{title}</strong>
        {text && <button onClick={() => onCopy(text, `${title}已复制`)}>复制</button>}
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

function VerifyForm({ task, onClose, onSubmit }) {
  const snapshot = task.metricsSnapshot || {};
  const [form, setForm] = useState({
    fans: snapshot.fans || '',
    plays: snapshot.plays || '',
    likes: snapshot.likes || '',
    comments: snapshot.comments || '',
    note: task.resultNote || '已核对发布'
  });
  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function submit(status, fallbackNote) {
    onSubmit({
      status,
      resultNote: form.note?.trim() || fallbackNote,
      metricsSnapshot: {
        fans: form.fans,
        plays: form.plays,
        likes: form.likes,
        comments: form.comments
      }
    });
  }
  return (
    <Modal title="抖音核对回填" onClose={onClose}>
      <div className="verifyMeta">
        <strong>{task.expectedTitle || '待核对内容'}</strong>
        <span>预期日期：{task.expectedPublishDate || '未记录'}</span>
        {task.douyinUrl && <a href={task.douyinUrl} target="_blank">打开抖音作品</a>}
      </div>
      <div className="formGrid">
        <label>粉丝<input value={form.fans} onChange={(e) => update('fans', e.target.value)} inputMode="numeric" /></label>
        <label>播放<input value={form.plays} onChange={(e) => update('plays', e.target.value)} inputMode="numeric" /></label>
        <label>点赞<input value={form.likes} onChange={(e) => update('likes', e.target.value)} inputMode="numeric" /></label>
        <label>评论<input value={form.comments} onChange={(e) => update('comments', e.target.value)} inputMode="numeric" /></label>
        <label className="wide">核对备注<textarea value={form.note} onChange={(e) => update('note', e.target.value)} /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button onClick={() => submit('not_found', '未找到作品或链接打不开')}>未找到作品</button>
        <button onClick={() => submit('mismatch', '内容或发布时间不匹配')}>内容异常</button>
        <button className="primary" onClick={() => submit('verified', '已核对发布')}>核对通过</button>
      </div>
    </Modal>
  );
}

function ViralView({ templates, onNew, onEdit, onAct, onCopy }) {
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
      <div className="hintBox">工作人员只需要把找到的抖音爆款链接放进来。链接会作为待分析任务，由我后续用青豆提文案、拆结构、判断适合哪些账号，再生成同类型候选。</div>
      {sortedTemplates.length === 0 ? <div className="empty">还没有待分析链接。先粘贴作品链接即可，不需要填写模板内容。</div> : (
        <div className="templateList">
          {sortedTemplates.map((item) => (
            <div className="templateRow" key={item.id}>
              <div className="rowTitle">
                <strong>{item.title}</strong>
                <span className={`status ${isPendingViral(item) ? 's-pending' : 's-ready'}`}>{isPendingViral(item) ? '待青豆分析' : '可生成'}</span>
              </div>
              <span>{item.category} · {item.rewritePolicy}</span>
              {item.sourceLink && <small>来源：{item.sourceLink}</small>}
              <p>{item.hotStructure}</p>
              <small>{item.rawText}</small>
              <div className="inlineActions">
                {item.sourceLink && <a className="button" href={item.sourceLink} target="_blank">打开原链接</a>}
                {isPendingViral(item) && <button onClick={() => copyQingdouTask(item, onCopy)}>复制青豆任务</button>}
                <button onClick={() => onEdit(item)}>{isPendingViral(item) ? '补分析结果' : '编辑分析'}</button>
                <button disabled={isPendingViral(item)} onClick={() => bulkGenerateViral(item, onAct)}>给所有账号生成今日爆款候选</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

async function copyQingdouTask(item, onCopy) {
  const result = await request(`/viral-templates/${item.id}/qingdou-task`);
  onCopy(result.text, '青豆分析任务已复制');
}

function isPendingViral(item) {
  return String(item.rawText || '').startsWith('待用青豆')
    || String(item.hotStructure || '').startsWith('待青豆')
    || item.category === '待分析';
}

function SeedView({ seeds, onNew, onAct }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>内容种子库</h2>
        <button className="button primary" onClick={onNew}>新增内容种子</button>
      </div>
      <div className="hintBox">素人种草和日常养号会优先从这里抽取模板，再按账号人设生成 3 条候选。可用变量：{'{城市}'} {'{年龄}'} {'{occupation}'} {'{项目}'} {'{阶段}'} {'{motivation}'}。</div>
      {seeds.length === 0 ? <div className="empty">暂无内容种子</div> : (
        <div className="templateList">
          {seeds.map((seed) => (
            <div className="templateRow" key={seed.id}>
              <strong>{seed.titleTemplate}</strong>
              <span>{seed.project} · {seed.stage} · {seed.contentKind} · {seed.format} · 使用 {seed.usageCount}</span>
              <p>{seed.contentTemplate}</p>
              <small>{seed.tags.join(' / ') || '未打标签'}</small>
              <div className="inlineActions">
                <button onClick={() => onAct(() => request(`/content-seeds/${seed.id}`, { method: 'DELETE' }), '内容种子已删除')}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SeedForm({ onClose, onSubmit }) {
  const [form, setForm] = useState({
    project: '通用',
    stage: '通用',
    contentKind: '日常养号',
    format: '图文',
    titleTemplate: '{城市}{occupation}的一天',
    contentTemplate: '{城市}{occupation}日常。\\n今天正常记录一点生活，不做得太像广告。\\n{motivation}',
    tagsText: '日常,起号',
    baseWeight: 1
  });
  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  return (
    <Modal title="新增内容种子" onClose={onClose}>
      <div className="formGrid">
        <label>项目<input value={form.project} onChange={(e) => update('project', e.target.value)} /></label>
        <label>阶段<select value={form.stage} onChange={(e) => update('stage', e.target.value)}>
          {['通用', ...STAGES].map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label>内容类型<select value={form.contentKind} onChange={(e) => update('contentKind', e.target.value)}>
          {KINDS.filter((item) => item !== '爆款提权').map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label>形式<select value={form.format} onChange={(e) => update('format', e.target.value)}>
          {['图文', '口播', '视频'].map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label className="wide">标题模板<input value={form.titleTemplate} onChange={(e) => update('titleTemplate', e.target.value)} /></label>
        <label className="wide">正文模板<textarea rows="7" value={form.contentTemplate} onChange={(e) => update('contentTemplate', e.target.value)} /></label>
        <label>标签<input value={form.tagsText} onChange={(e) => update('tagsText', e.target.value)} /></label>
        <label>权重<input value={form.baseWeight} onChange={(e) => update('baseWeight', e.target.value)} /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit({
          ...form,
          tags: form.tagsText.split(/,|，/).map((item) => item.trim()).filter(Boolean),
          baseWeight: Number(form.baseWeight) || 1
        })}>保存</button>
      </div>
    </Modal>
  );
}

function SettingsView({ config, onAct, onCopy, canOpenLocalPaths }) {
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">系统配置</p>
          <h1>运行状态与模板</h1>
          <p>这里显示当前工作台实际采用的阶段、内容比例、素材模板和本地目录。后续可继续扩展成可编辑配置。</p>
        </div>
        <div className="stats">
          <Metric label="图片接口" value={config.image?.ready ? '已接入' : '待接入'} />
          <Metric label="文案接口" value={config.llmKeyReady ? '已接入' : '待接入'} />
          <Metric label="局域网" value={config.network?.lanEnabled ? '已开放' : '本机'} />
          <Metric label="阶段" value={config.stages.length} />
          <Metric label="内容类" value={config.contentKinds.length} />
          <Metric label="就绪" value={`${config.readiness?.summary?.ready || 0}/${config.readiness?.summary?.total || 0}`} />
        </div>
      </section>
      <section className="panel">
        <div className="sectionHead">
          <h2>局域网访问</h2>
          <button onClick={() => onCopy(networkSetupText(config), '局域网配置说明已复制')}>复制配置说明</button>
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
        <div className="sectionHead">
          <h2>系统验收清单</h2>
          <span>等待 {config.readiness?.summary?.waiting || 0} · 警告 {config.readiness?.summary?.warning || 0}</span>
        </div>
        <div className="templateList">
          {(config.readiness?.checks || []).map((item) => (
            <div className="templateRow readinessRow" key={item.key}>
              <div className="rowTitle">
                <span className={`status ${readinessStatusClass(item.status)}`}>{readinessStatusText(item.status)}</span>
                <strong>{item.label}</strong>
              </div>
              <span>{item.detail}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="sectionHead"><h2>本地素材根目录</h2></div>
        <div className="path">{config.materialRoot}</div>
      </section>
      <section className="panel">
          <div className="sectionHead">
          <h2>助手工作目录</h2>
          <div className="headerActions">
            <span>{config.localAi?.ready ? '本地助手已接入' : '本地助手待接入'}</span>
            <button onClick={() => onCopy(localAiSetupText(config), '本地助手接入说明已复制')}>复制接入说明</button>
            {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: config.operatorPacketDir }) }), '已打开助手工作包目录')}>打开工作包目录</button>}
            {canOpenLocalPaths && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: config.aiConsultDir }) }), '已打开顾问记录目录')}>打开顾问记录目录</button>}
          </div>
        </div>
        <div className="templateList">
          <div className="templateRow">
            <strong>工作包目录</strong>
            <span>{config.operatorPacketDir}</span>
          </div>
          <div className="templateRow">
            <strong>顾问记录目录</strong>
            <span>{config.aiConsultDir}</span>
          </div>
          <div className="templateRow">
            <strong>本地助手命令</strong>
            <span>{config.localAi?.ready ? config.localAi.command : config.localAi?.message}</span>
          </div>
          <div className="templateRow">
            <strong>文案模型</strong>
            <span>{config.llm?.ready ? `${config.llm.model}｜${config.llm.baseUrl}` : '未接入，候选稿使用本地模板生成'}</span>
          </div>
          <div className="templateRow">
            <strong>图片生成接口</strong>
            <span>{config.image?.ready ? `${config.image.model}｜${config.image.size}` : `${config.image?.missing || '未接入'}，图片任务仍可复制提示词`}</span>
          </div>
        </div>
      </section>
      <section className="twoCol">
        <div className="panel">
          <div className="sectionHead"><h2>生命周期内容比例</h2></div>
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

function localAiSetupText(config) {
  return [
    '本地助手接入说明',
    '',
    '当前状态：',
    config.localAi?.ready
      ? `已接入：${config.localAi.command}`
      : `未接入：${config.localAi?.message || '未找到本地助手命令'}`,
    '',
    '系统会自动查找：claude / clude / claude-code',
    '',
    '如果命令不在 PATH，请在 app/.env 填：',
    'LOCAL_CLAUDE_COMMAND=/完整路径/claude',
    '',
    '如果只想生成工作包、不调用本地助手：',
    'SOUREN_LOCAL_AI_DISABLED=1',
    '',
    '验证命令：',
    'cd /Users/licc/Desktop/素人系统/app',
    'npm run doctor',
    'npm run consult',
    'npm run verify:consult',
    '',
    `助手工作包目录：${config.operatorPacketDir}`,
    `顾问记录目录：${config.aiConsultDir}`
  ].join('\n');
}

function networkSetupText(config) {
  const lanUrls = config.network?.lanEnabled ? (config.network?.lanUrls || []) : [];
  return [
    '局域网工作台配置',
    '',
    '1. 在主机 app/.env 中设置：',
    'SOUREN_HOST=0.0.0.0',
    'SOUREN_ACCESS_CODE=这里填一个给工作人员的访问码',
    '',
    '2. 重启工作台。',
    '',
    '3. 把下面任意一个网址发给同一局域网内的工作人员：',
    ...(lanUrls.length ? lanUrls : ['当前未检测到局域网地址，请确认已经设置 SOUREN_HOST=0.0.0.0 并重启。']),
    '',
    '工作人员只需要打开网址、输入访问码，然后处理对接、复制交付内容和回填状态。'
  ].join('\n');
}

function readinessStatusClass(status) {
  if (status === 'ready') return 's-ok';
  if (status === 'waiting') return 's-pending';
  return 's-bad';
}

function readinessStatusText(status) {
  if (status === 'ready') return '已就绪';
  if (status === 'waiting') return '待接入';
  return '需处理';
}

function bulkGenerateViral(template, onAct) {
  const date = window.prompt('生成到哪一天？', today());
  if (!date) return;
  onAct(
    () => request(`/viral-templates/${template.id}/bulk-generate`, {
      method: 'POST',
      body: JSON.stringify({ date })
    }),
    '已给所有账号生成爆款候选'
  );
}

function CaseForm({ initial, onClose, onSubmit }) {
  const isCreate = !initial;
  const defaults = useMemo(() => initial ? null : randomCaseDefaults(), [initial]);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(initial));
  const [form, setForm] = useState(() => ({
    weixinNick: initial?.weixinNick || defaults?.weixinNick || '',
    douyinId: initial?.douyinId || '',
    douyinUrl: initial?.douyinUrl || '',
    project: initial?.project || '吸脂',
    stage: initial?.stage || '起号期',
    staff: initial?.staff || '',
    persona: {
      city: initial?.persona?.city || defaults?.persona.city || '',
      age: initial?.persona?.age || defaults?.persona.age || '',
      occupation: initial?.persona?.occupation || defaults?.persona.occupation || '',
      tone: initial?.persona?.tone || defaults?.persona.tone || '',
      motivation: initial?.persona?.motivation || defaults?.persona.motivation || ''
    }
  }));
  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  function updatePersona(key, value) {
    setForm((prev) => ({ ...prev, persona: { ...prev.persona, [key]: value } }));
  }
  function reroll() {
    const next = randomCaseDefaults();
    setForm((prev) => ({ ...prev, weixinNick: next.weixinNick, persona: next.persona }));
  }
  return (
    <Modal title={initial ? '编辑案例' : '新建案例'} onClose={onClose}>
      {isCreate && <div className="hintBox">新建时只需要填对接人和抖音链接。昵称和人设默认随机生成，用来先建目录、排期和交付链路，后面需要再细改。</div>}
      {isCreate && (
        <div className="generatedPreview">
          <strong>{form.weixinNick}</strong>
          <span>{personaText(form.persona)}</span>
          <small>{form.persona.motivation}</small>
        </div>
      )}
      <div className="formGrid">
        {(!isCreate || showAdvanced) && (
          <>
            <label>兼职微信昵称<input value={form.weixinNick} onChange={(e) => update('weixinNick', e.target.value)} /></label>
            <label>抖音号<input value={form.douyinId} onChange={(e) => update('douyinId', e.target.value)} /></label>
          </>
        )}
        <label>对接咨询/负责人<input placeholder="例如：咨询A / 小王" value={form.staff} onChange={(e) => update('staff', e.target.value)} /></label>
        <label className={showAdvanced || !isCreate ? '' : 'wide'}>抖音主页/作品链接<input value={form.douyinUrl} onChange={(e) => update('douyinUrl', e.target.value)} /></label>
        <label>项目<input value={form.project} onChange={(e) => update('project', e.target.value)} /></label>
        <label>阶段<select value={form.stage} onChange={(e) => update('stage', e.target.value)}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></label>
        {(!isCreate || showAdvanced) && (
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
        {isCreate && <button onClick={reroll}>随机换一组</button>}
        {isCreate && <button onClick={() => setShowAdvanced((prev) => !prev)}>{showAdvanced ? '收起随机信息' : '编辑随机信息'}</button>}
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit({ ...form, persona: { ...form.persona, age: Number(form.persona.age) || '' } })}>{initial ? '保存' : '创建'}</button>
      </div>
    </Modal>
  );
}

function BulkCaseForm({ onClose, onSubmit }) {
  const [text, setText] = useState('小林,dy001,https://www.douyin.com/,吸脂,起号期,成都,25,上班族,自然,记录状态变化,咨询A\n小陈,dy002,,吸脂,起号期,杭州,27,自由职业,轻松,想做生活记录,咨询B');
  const [generateSlots, setGenerateSlots] = useState(true);
  const [days, setDays] = useState(7);
  return (
    <Modal title="批量导入兼职/账号" onClose={onClose}>
      <div className="hintBox">
        每行一个账号，支持逗号或 Tab 分隔。字段顺序：
        微信昵称, 抖音号, 抖音主页链接, 项目, 阶段, 城市, 年龄, 职业, 语气, 动机故事, 对接咨询/负责人
      </div>
      <div className="formGrid">
        <label className="wide">导入内容<textarea rows="10" value={text} onChange={(e) => setText(e.target.value)} /></label>
        <label className="checkLine"><input type="checkbox" checked={generateSlots} onChange={(e) => setGenerateSlots(e.target.checked)} />导入后自动生成排期</label>
        <label>生成天数<input value={days} onChange={(e) => setDays(e.target.value)} /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit({ text, generateSlots, days: Number(days) || 7 })}>导入</button>
      </div>
    </Modal>
  );
}

function SlotForm({ caze, onClose, onSubmit }) {
  const [form, setForm] = useState({
    date: today(),
    timeWindow: '19:00-21:00',
    contentKind: '日常养号',
    stage: caze.stage || '起号期',
    goal: ''
  });
  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  return (
    <Modal title="手动新增内容槽位" onClose={onClose}>
      <div className="formGrid">
        <label>日期<input value={form.date} onChange={(e) => update('date', e.target.value)} /></label>
        <label>时间窗<input value={form.timeWindow} onChange={(e) => update('timeWindow', e.target.value)} /></label>
        <label>内容类型<select value={form.contentKind} onChange={(e) => update('contentKind', e.target.value)}>{KINDS.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>阶段<select value={form.stage} onChange={(e) => update('stage', e.target.value)}>{STAGES.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="wide">目标/备注<textarea value={form.goal} onChange={(e) => update('goal', e.target.value)} placeholder="留空则按类型自动生成目标" /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit(form)}>新增</button>
      </div>
    </Modal>
  );
}

function ViralForm({ initial, onClose, onSubmit }) {
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
  return (
    <Modal title={initial ? '补爆款分析' : '粘贴爆款链接'} onClose={onClose}>
      <div className="hintBox">{initial ? '这里用于把青豆提取结果、结构分析和适合账号补回系统。补完后，这条爆款链接就可以批量生成人设化候选。' : '工作人员只需要贴抖音作品链接。标题、正文、爆点结构这些可以留空，后续由我用青豆提取和分析。'}</div>
      <div className="formGrid">
        <label className="wide">爆款视频链接<input placeholder="先贴抖音作品链接即可" value={form.sourceLink} onChange={(e) => update('sourceLink', e.target.value)} /></label>
        <label className="wide">备注标题<input placeholder="可留空；需要区分来源时再写" value={form.title} onChange={(e) => update('title', e.target.value)} /></label>
        <label className="wide">青豆提取结果<textarea rows="5" placeholder="可留空，后续由我提取后补充" value={form.rawText} onChange={(e) => update('rawText', e.target.value)} /></label>
        <label>类别<select value={form.category} onChange={(e) => update('category', e.target.value)}>
          {['待分析', '情绪', '职场', '穿搭', '美食', '本地生活', '清单', '反差故事'].map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label>改写策略<select value={form.rewritePolicy} onChange={(e) => update('rewritePolicy', e.target.value)}>
          {['结构模仿', '话题模仿', '仅参考'].map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label className="wide">适合人设关键词<input placeholder="例如：成都,上班族,起号期。留空表示全部适合" value={form.suitableText} onChange={(e) => update('suitableText', e.target.value)} /></label>
        <label className="wide">禁用人设关键词<input placeholder="例如：自由职业,收尾期。命中则不批量生成" value={form.forbiddenText} onChange={(e) => update('forbiddenText', e.target.value)} /></label>
        <label className="wide">分析结论<textarea placeholder="可留空，后续补结构、适合账号和下一步建议" value={form.hotStructure} onChange={(e) => update('hotStructure', e.target.value)} /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit({
          ...form,
          suitablePersonas: form.suitableText.split(/,|，|\n/).map((item) => item.trim()).filter(Boolean),
          forbiddenPersonas: form.forbiddenText.split(/,|，|\n/).map((item) => item.trim()).filter(Boolean)
        })}>{initial ? '保存分析' : '保存'}</button>
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
