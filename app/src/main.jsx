import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const STAGES = ['起号期', '决策期', '术后恢复期', '成果期', '收尾期'];
const KINDS = ['素人种草', '日常养号', '爆款提权'];
const API = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
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
  return 'bad';
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
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [caseFormOpen, setCaseFormOpen] = useState(false);
  const [bulkCaseOpen, setBulkCaseOpen] = useState(false);
  const [viralFormOpen, setViralFormOpen] = useState(false);
  const [seedFormOpen, setSeedFormOpen] = useState(false);

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
    refresh().catch((err) => showToast(err.message));
  }, [selectedCaseId]);

  function showToast(message) {
    setToast(message);
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => setToast(''), 2200);
  }

  async function act(fn, message) {
    try {
      await fn();
      await refresh();
      if (message) showToast(message);
    } catch (err) {
      showToast(err.message);
    }
  }

  async function importBackup(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await request('/import', { method: 'POST', body: JSON.stringify(payload) });
      await refresh();
      showToast('备份已导入');
    } catch (err) {
      showToast(`导入失败：${err.message}`);
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
      <button className={view === 'review' ? 'active' : ''} onClick={() => setView('review')}>数据复盘</button>
      <button className={view === 'schedule' ? 'active' : ''} onClick={() => setView('schedule')}>排期规划</button>
      <button className={view === 'cases' ? 'active' : ''} onClick={() => setView('cases')}>案例库</button>
      <button className={view === 'viral' ? 'active' : ''} onClick={() => setView('viral')}>爆款模板</button>
      <button className={view === 'seeds' ? 'active' : ''} onClick={() => setView('seeds')}>内容种子</button>
      <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>配置</button>
    </div>
  );

  return (
    <div>
      <header className="topbar">
        <div className="brand">素人种草运营工作台</div>
        {nav}
        <div className="topActions">
          <a className="button ghost" href="/api/export" target="_blank">导出备份</a>
          <button className="button ghost" onClick={() => act(() => request('/backups', { method: 'POST', body: JSON.stringify({ reason: 'manual' }) }), '本地备份已创建')}>创建本地备份</button>
          <label className="button ghost fileButton">
            导入备份
            <input type="file" accept="application/json" onChange={(e) => importBackup(e.target.files?.[0])} />
          </label>
          <button className="button primary" onClick={() => setCaseFormOpen(true)}>新建案例</button>
        </div>
      </header>
      <main className="page">
        {loading && <div className="empty">加载中</div>}
        {!loading && view === 'dashboard' && dashboard && (
          <Dashboard data={dashboard} onOpenCase={openCase} onAct={act} onCopy={copyText} />
        )}
        {!loading && view === 'review' && review && (
          <ReviewView data={review} onOpenCase={openCase} />
        )}
        {!loading && view === 'schedule' && schedule && (
          <ScheduleView data={schedule} onOpenCase={openCase} onAct={act} onCopy={copyText} />
        )}
        {!loading && view === 'cases' && (
          <CasesView cases={cases} onOpenCase={openCase} onNew={() => setCaseFormOpen(true)} onBulk={() => setBulkCaseOpen(true)} onAct={act} />
        )}
        {!loading && view === 'case' && caseDetail && (
          <CaseDetail detail={caseDetail} onAct={act} onCopy={copyText} onBack={() => setView('cases')} />
        )}
        {!loading && view === 'viral' && (
          <ViralView templates={viralTemplates} onNew={() => setViralFormOpen(true)} onAct={act} />
        )}
        {!loading && view === 'seeds' && (
          <SeedView seeds={contentSeeds} onNew={() => setSeedFormOpen(true)} onAct={act} />
        )}
        {!loading && view === 'settings' && config && (
          <SettingsView config={config} />
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
          }, '案例已创建，素材目录已生成')}
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
          onClose={() => setViralFormOpen(false)}
          onSubmit={(payload) => act(async () => {
            await request('/viral-templates', { method: 'POST', body: JSON.stringify(payload) });
            setViralFormOpen(false);
          }, '爆款模板已保存')}
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
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Dashboard({ data, onOpenCase, onAct, onCopy }) {
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">今日 {data.today}</p>
          <h1>运营中控台</h1>
          <p>先处理待生成、待选择和待交付，再核对兼职回传。这里按 40+ 账号的日常动作聚合，不需要逐个翻案例。</p>
        </div>
        <div className="stats">
          <Metric label="案例" value={data.counts.cases} />
          <Metric label="待生成" value={data.counts.pendingGenerate} />
          <Metric label="待选择" value={data.counts.pendingChoose} />
          <Metric label="待交付" value={data.counts.readyDelivery} />
          <Metric label="待核对" value={data.counts.pendingVerify} />
        </div>
      </section>

      <TaskSection title="今天要处理" items={data.todaySlots} empty="今天没有到期任务" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} />
      <TaskSection title="待生成候选稿" items={data.pendingGenerate} empty="没有待生成内容" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} />
      <TaskSection title="待选择候选" items={data.pendingChoose} empty="没有待选择内容" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} />
      <TaskSection title="可微信交付" items={data.readyDelivery} empty="没有可交付任务" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} />
      <TaskSection title="待抖音核对" items={data.pendingVerify} empty="没有待核对任务" onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} />

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
                {item.actions?.[0] && <small>{item.actions[0]}</small>}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
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
          <Metric label="待图片Key" value={data.totals.imageWaitingKey} />
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

function ScheduleView({ data, onOpenCase, onAct, onCopy }) {
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
          <input placeholder="搜索账号 / 抖音号 / 案例编号 / 目标" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            <option value="7">未来 7 天</option>
            <option value="14">未来 14 天</option>
            <option value="30">未来 30 天</option>
            <option value="60">未来 60 天</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {['全部状态', '待生成', '候选待选', '已锁定', '可交付', '已派发', '已汇报', '已核对', '异常'].map((item) => <option key={item}>{item}</option>)}
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
              <ScheduleRow key={slot.id} slot={slot} onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ScheduleRow({ slot, onOpenCase, onAct, onCopy }) {
  const caze = slot.case || {};
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
        <small>{caze.caseCode || '未建案例'} · 候选 {slot.candidateCount}</small>
      </div>
      <div className="rowActions">
        {slot.status === '待生成' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/generate-candidates`, { method: 'POST' }), '已生成候选')}>生成候选</button>}
        {slot.status === '已锁定' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/delivery`, { method: 'POST' }), '交付包已生成')}>生成交付包</button>}
        {slot.deliveryDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: slot.deliveryDir }) }), '已打开交付包')}>打开交付包</button>}
        {slot.selectedCandidate && <button onClick={() => onCopy(slot.selectedCandidate.operatorInstruction, '执行说明已复制')}>复制执行说明</button>}
        {slot.selectedCandidate && <button onClick={() => onCopy(`${slot.selectedCandidate.title}\n\n${slot.selectedCandidate.publishText}`, '发布文案已复制')}>复制发布文案</button>}
        {slot.status === '可交付' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) }), '已标记派发')}>标记派发</button>}
        {slot.status === '已派发' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已汇报' }) }), '已进入待核对')}>兼职已汇报</button>}
        {slot.status === '已汇报' && caze.douyinUrl && <a className="button" href={caze.douyinUrl} target="_blank">打开抖音</a>}
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

function TaskSection({ title, items, empty, onOpenCase, onAct, onCopy }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>{title}</h2>
        <span>{items.length} 条</span>
      </div>
      {items.length === 0 ? <div className="empty">{empty}</div> : (
        <div className="taskList">
          {items.map((slot) => (
            <TaskRow key={slot.id} slot={slot} onOpenCase={onOpenCase} onAct={onAct} onCopy={onCopy} />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskRow({ slot, onOpenCase, onAct, onCopy }) {
  const caze = slot.case || {};
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
        <small>{caze.douyinId || '未填抖音号'} · {slot.stage}</small>
      </div>
      <div className="rowActions">
        {slot.status === '待生成' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/generate-candidates`, { method: 'POST' }), '已生成 3 条候选')}>生成候选</button>}
        {slot.status === '已锁定' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/delivery`, { method: 'POST' }), '交付包已生成')}>生成交付包</button>}
        {slot.deliveryDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: slot.deliveryDir }) }), '已打开交付包')}>打开交付包</button>}
        {slot.selectedCandidate && <button onClick={() => onCopy(slot.selectedCandidate.operatorInstruction, '执行说明已复制')}>复制执行说明</button>}
        {slot.selectedCandidate && <button onClick={() => onCopy(`${slot.selectedCandidate.title}\n\n${slot.selectedCandidate.publishText}`, '发布文案已复制')}>复制发布文案</button>}
        {slot.status === '可交付' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) }), '已标记派发')}>标记派发</button>}
        {slot.status === '已派发' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已汇报' }) }), '已进入待核对')}>兼职已汇报</button>}
        {slot.status === '已汇报' && caze.douyinUrl && <a className="button" href={caze.douyinUrl} target="_blank">打开抖音</a>}
      </div>
    </div>
  );
}

function CasesView({ cases, onOpenCase, onNew, onBulk, onAct }) {
  const [query, setQuery] = useState('');
  const [stageFilter, setStageFilter] = useState('全部阶段');
  const [healthFilter, setHealthFilter] = useState('全部状态');
  const filtered = cases.filter((item) => {
    const q = query.trim().toLowerCase();
    const haystack = `${item.weixinNick} ${item.caseCode} ${item.douyinId} ${item.project} ${personaText(item.persona)}`.toLowerCase();
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
        <input placeholder="搜索微信昵称 / 抖音号 / 案例编号 / 项目 / 人设" value={query} onChange={(e) => setQuery(e.target.value)} />
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
                <em>{item.douyinId || '未填抖音号'} · {item.healthStatus}</em>
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
  if (!window.confirm(`删除案例「${item.weixinNick}」？数据库记录会删除，本地素材目录不会自动删除。`)) return;
  onAct(() => request(`/cases/${item.id}`, { method: 'DELETE' }), '案例已删除');
}

function CaseDetail({ detail, onAct, onCopy, onBack }) {
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
          <p>{caze.project} · {caze.stage} · {personaText(caze.persona)}</p>
          {healthReasons.length > 0 && <p className="healthLine">当前提示：{healthReasons.join(' / ')}</p>}
          {healthActions.length > 0 && <p className="healthLine">建议动作：{healthActions.join(' / ')}</p>}
          <p className="path">素材目录：{caze.localCaseDir}</p>
        </div>
        <div className="headerActions">
          <button onClick={() => setEditOpen(true)}>编辑案例</button>
          <button onClick={() => onAct(() => request(`/cases/${caze.id}/generate-slots`, { method: 'POST', body: JSON.stringify({ days: 30 }) }), '已补齐 30 天排期槽位')}>生成30天排期</button>
          <button onClick={() => setSlotFormOpen(true)}>手动加槽位</button>
          <button onClick={() => onAct(() => request(`/cases/${caze.id}/scan-assets`, { method: 'POST' }), '素材扫描完成')}>扫描素材</button>
          <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: caze.localCaseDir }) }), '已打开案例目录')}>打开素材目录</button>
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
              <SlotCard key={slot.id} slot={slot} candidates={candidatesBySlot[slot.id] || []} caze={caze} onAct={onAct} onCopy={onCopy} />
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
                      }), '已按素材缺口创建 Image 任务')}>创建 Image 任务</button>
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
                  <span>{task.status}</span>
                  <small>{task.outputDir}</small>
                  <div className="inlineActions">
                    <button onClick={() => onCopy(task.brief, '剪辑任务单已复制')}>复制任务单</button>
                    <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: task.outputDir }) }), '已打开剪辑目录')}>打开目录</button>
                    {['review', 'approved', 'rejected'].map((status) => (
                      <button key={status} onClick={() => onAct(() => request(`/clip-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), `剪辑任务已标记：${status}`)}>{status}</button>
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
            <h2>Image 任务</h2>
            <button onClick={() => onAct(() => request('/image-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, purpose: '日常养号' }) }), '图片任务已创建')}>新建图片任务</button>
          </div>
          {imageTasks.length === 0 ? <div className="empty">暂无图片任务</div> : (
            <div className="assetList">
              {imageTasks.map((task) => (
                <div className="assetRow" key={task.id}>
                  <strong>{task.purpose}</strong>
                  <span>{task.status}</span>
                  <small>{task.prompt}</small>
                  <div className="inlineActions">
                    <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: task.outputDir }) }), '已打开输出目录')}>打开目录</button>
                    {['review', 'approved', 'rejected'].map((status) => (
                      <button key={status} onClick={() => onAct(() => request(`/image-tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }), `图片任务已标记：${status}`)}>{status}</button>
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
                  <div className="rowTitle"><strong>{task.expectedTitle || '待核对内容'}</strong><span className={`status ${statusClass(task.status)}`}>{task.status}</span></div>
                  <p>{task.expectedPublishDate} · 预期素材 {task.expectedAssets?.length || 0} 个 · {task.resultNote || '等待打开抖音核对'}</p>
                </div>
                <div className="rowActions">
                  {task.douyinUrl && <a className="button" href={task.douyinUrl} target="_blank">打开抖音</a>}
                  <button onClick={() => verifyWithMetrics(task, onAct)}>核对并回填</button>
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

function SlotCard({ slot, candidates, caze, onAct, onCopy }) {
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
        {selected && <button onClick={() => onAct(() => request(`/slots/${slot.id}/delivery`, { method: 'POST' }), '交付包已生成')}>生成交付包</button>}
        {selected && <button onClick={() => onAct(() => request('/clip-tasks', { method: 'POST', body: JSON.stringify({ caseId: caze.id, planSlotId: slot.id, title: `${slot.date}_${slot.contentKind}_剪辑任务` }) }), '剪辑任务已创建')}>创建剪辑任务</button>}
        {slot.deliveryDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: slot.deliveryDir }) }), '已打开交付包')}>打开交付包</button>}
        {slot.status === '可交付' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) }), '已派发')}>标记派发</button>}
        {slot.status === '已派发' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已汇报' }) }), '进入待核对')}>兼职已汇报</button>}
        {slot.status !== '已核对' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '异常' }) }), '已标记异常')}>异常</button>}
      </div>
      {slot.deliveryDir && <div className="path">交付包：{slot.deliveryDir}</div>}
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

function verifyWithMetrics(task, onAct) {
  const raw = window.prompt('回填数据：粉丝,播放,点赞,评论。可留空，例如：120,3000,88,12', '');
  if (raw === null) return;
  const [fans, plays, likes, comments] = raw.split(',').map((item) => item.trim());
  const note = window.prompt('核对备注', '已核对发布') || '已核对发布';
  onAct(
    () => request(`/verify-tasks/${task.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'verified',
        resultNote: note,
        metricsSnapshot: { fans, plays, likes, comments }
      })
    }),
    '已核对并回填数据'
  );
}

function ViralView({ templates, onNew, onAct }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>爆款模板库</h2>
        <button className="button primary" onClick={onNew}>录入爆款模板</button>
      </div>
      {templates.length === 0 ? <div className="empty">还没有爆款模板。录入后，爆款提权槽位会优先套用最新模板。</div> : (
        <div className="templateList">
          {templates.map((item) => (
            <div className="templateRow" key={item.id}>
              <strong>{item.title}</strong>
              <span>{item.category} · {item.rewritePolicy}</span>
              <p>{item.hotStructure}</p>
              <small>{item.rawText}</small>
              <div className="inlineActions">
                <button onClick={() => bulkGenerateViral(item, onAct)}>给所有账号生成今日爆款候选</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
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

function SettingsView({ config }) {
  return (
    <div className="stack">
      <section className="hero">
        <div>
          <p className="eyebrow">系统配置</p>
          <h1>运行状态与模板</h1>
          <p>这里显示当前工作台实际采用的阶段、内容比例、素材模板和本地目录。后续可继续扩展成可编辑配置。</p>
        </div>
        <div className="stats">
          <Metric label="Image Key" value={config.imageKeyReady ? 'ON' : '空'} />
          <Metric label="LLM Key" value={config.llmKeyReady ? 'ON' : '空'} />
          <Metric label="阶段" value={config.stages.length} />
          <Metric label="内容类" value={config.contentKinds.length} />
          <Metric label="模板" value={Object.keys(config.materialTemplates).length} />
        </div>
      </section>
      <section className="panel">
        <div className="sectionHead"><h2>本地素材根目录</h2></div>
        <div className="path">{config.materialRoot}</div>
      </section>
      <section className="panel">
        <div className="sectionHead"><h2>本地备份</h2><span>{config.backups?.length || 0} 个最近备份</span></div>
        <div className="path">{config.backupDir}</div>
        {!config.backups?.length ? <div className="empty">暂无本地备份。顶部可以手动创建，导入备份前也会自动创建一份。</div> : (
          <div className="templateList">
            {config.backups.map((item) => (
              <div className="templateRow" key={item.path}>
                <strong>{item.name}</strong>
                <span>{Math.ceil(item.size / 1024)} KB · {item.updatedAt}</span>
                <small>{item.path}</small>
              </div>
            ))}
          </div>
        )}
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
  const [form, setForm] = useState(() => ({
    weixinNick: initial?.weixinNick || '',
    douyinId: initial?.douyinId || '',
    douyinUrl: initial?.douyinUrl || '',
    project: initial?.project || '吸脂',
    stage: initial?.stage || '起号期',
    staff: initial?.staff || '',
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
  return (
    <Modal title={initial ? '编辑案例' : '新建案例'} onClose={onClose}>
      <div className="formGrid">
        <label>兼职微信昵称<input value={form.weixinNick} onChange={(e) => update('weixinNick', e.target.value)} /></label>
        <label>抖音号<input value={form.douyinId} onChange={(e) => update('douyinId', e.target.value)} /></label>
        <label className="wide">抖音主页链接<input value={form.douyinUrl} onChange={(e) => update('douyinUrl', e.target.value)} /></label>
        <label>项目<input value={form.project} onChange={(e) => update('project', e.target.value)} /></label>
        <label>阶段<select value={form.stage} onChange={(e) => update('stage', e.target.value)}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>城市<input value={form.persona.city} onChange={(e) => updatePersona('city', e.target.value)} /></label>
        <label>年龄<input value={form.persona.age} onChange={(e) => updatePersona('age', e.target.value)} /></label>
        <label>职业<input value={form.persona.occupation} onChange={(e) => updatePersona('occupation', e.target.value)} /></label>
        <label>语气<input value={form.persona.tone} onChange={(e) => updatePersona('tone', e.target.value)} /></label>
        <label className="wide">动机故事<textarea value={form.persona.motivation} onChange={(e) => updatePersona('motivation', e.target.value)} /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit({ ...form, persona: { ...form.persona, age: Number(form.persona.age) || '' } })}>{initial ? '保存' : '创建'}</button>
      </div>
    </Modal>
  );
}

function BulkCaseForm({ onClose, onSubmit }) {
  const [text, setText] = useState('小林,dy001,https://www.douyin.com/,吸脂,起号期,成都,25,上班族,自然,记录状态变化\n小陈,dy002,,吸脂,起号期,杭州,27,自由职业,轻松,想做生活记录');
  const [generateSlots, setGenerateSlots] = useState(true);
  const [days, setDays] = useState(7);
  return (
    <Modal title="批量导入兼职/账号" onClose={onClose}>
      <div className="hintBox">
        每行一个账号，支持逗号或 Tab 分隔。字段顺序：
        微信昵称, 抖音号, 抖音主页链接, 项目, 阶段, 城市, 年龄, 职业, 语气, 动机故事
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

function ViralForm({ onClose, onSubmit }) {
  const [form, setForm] = useState({
    title: '',
    rawText: '',
    sourceLink: '',
    category: '情绪',
    hotStructure: '开头提出共鸣问题，中段列出3个细节，结尾引导评论',
    suitableText: '',
    forbiddenText: '',
    rewritePolicy: '结构模仿'
  });
  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }
  return (
    <Modal title="录入爆款模板" onClose={onClose}>
      <div className="formGrid">
        <label className="wide">爆款标题<input value={form.title} onChange={(e) => update('title', e.target.value)} /></label>
        <label className="wide">正文/口播<textarea rows="5" value={form.rawText} onChange={(e) => update('rawText', e.target.value)} /></label>
        <label>来源链接<input value={form.sourceLink} onChange={(e) => update('sourceLink', e.target.value)} /></label>
        <label>类别<select value={form.category} onChange={(e) => update('category', e.target.value)}>
          {['情绪', '职场', '穿搭', '美食', '本地生活', '清单', '反差故事'].map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label>改写策略<select value={form.rewritePolicy} onChange={(e) => update('rewritePolicy', e.target.value)}>
          {['结构模仿', '话题模仿', '仅参考'].map((item) => <option key={item}>{item}</option>)}
        </select></label>
        <label className="wide">适合人设关键词<input placeholder="例如：成都,上班族,起号期。留空表示全部适合" value={form.suitableText} onChange={(e) => update('suitableText', e.target.value)} /></label>
        <label className="wide">禁用人设关键词<input placeholder="例如：自由职业,收尾期。命中则不批量生成" value={form.forbiddenText} onChange={(e) => update('forbiddenText', e.target.value)} /></label>
        <label className="wide">爆点结构<textarea value={form.hotStructure} onChange={(e) => update('hotStructure', e.target.value)} /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit({
          ...form,
          suitablePersonas: form.suitableText.split(/,|，|\n/).map((item) => item.trim()).filter(Boolean),
          forbiddenPersonas: form.forbiddenText.split(/,|，|\n/).map((item) => item.trim()).filter(Boolean)
        })}>保存</button>
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
