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
  const [cases, setCases] = useState([]);
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [caseDetail, setCaseDetail] = useState(null);
  const [viralTemplates, setViralTemplates] = useState([]);
  const [config, setConfig] = useState(null);
  const [toast, setToast] = useState('');
  const [loading, setLoading] = useState(true);
  const [caseFormOpen, setCaseFormOpen] = useState(false);
  const [viralFormOpen, setViralFormOpen] = useState(false);

  async function refresh() {
    const [dash, caseRows, viralRows, configData] = await Promise.all([
      request('/dashboard'),
      request('/cases'),
      request('/viral-templates'),
      request('/config')
    ]);
    setDashboard(dash);
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

  async function openCase(id) {
    setSelectedCaseId(id);
    setView('case');
    const detail = await request(`/cases/${id}`);
    setCaseDetail(detail);
  }

  const nav = (
    <div className="nav">
      <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')}>今日中控台</button>
      <button className={view === 'cases' ? 'active' : ''} onClick={() => setView('cases')}>案例库</button>
      <button className={view === 'viral' ? 'active' : ''} onClick={() => setView('viral')}>爆款模板</button>
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
          <Dashboard data={dashboard} onOpenCase={openCase} onAct={act} />
        )}
        {!loading && view === 'cases' && (
          <CasesView cases={cases} onOpenCase={openCase} onNew={() => setCaseFormOpen(true)} />
        )}
        {!loading && view === 'case' && caseDetail && (
          <CaseDetail detail={caseDetail} onAct={act} onBack={() => setView('cases')} />
        )}
        {!loading && view === 'viral' && (
          <ViralView templates={viralTemplates} onNew={() => setViralFormOpen(true)} onAct={act} />
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
      {viralFormOpen && (
        <ViralForm
          onClose={() => setViralFormOpen(false)}
          onSubmit={(payload) => act(async () => {
            await request('/viral-templates', { method: 'POST', body: JSON.stringify(payload) });
            setViralFormOpen(false);
          }, '爆款模板已保存')}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Dashboard({ data, onOpenCase, onAct }) {
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

      <TaskSection title="今天要处理" items={data.todaySlots} empty="今天没有到期任务" onOpenCase={onOpenCase} onAct={onAct} />
      <TaskSection title="待生成候选稿" items={data.pendingGenerate} empty="没有待生成内容" onOpenCase={onOpenCase} onAct={onAct} />
      <TaskSection title="待选择候选" items={data.pendingChoose} empty="没有待选择内容" onOpenCase={onOpenCase} onAct={onAct} />
      <TaskSection title="可微信交付" items={data.readyDelivery} empty="没有可交付任务" onOpenCase={onOpenCase} onAct={onAct} />
      <TaskSection title="待抖音核对" items={data.pendingVerify} empty="没有待核对任务" onOpenCase={onOpenCase} onAct={onAct} />

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
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TaskSection({ title, items, empty, onOpenCase, onAct }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>{title}</h2>
        <span>{items.length} 条</span>
      </div>
      {items.length === 0 ? <div className="empty">{empty}</div> : (
        <div className="taskList">
          {items.map((slot) => (
            <TaskRow key={slot.id} slot={slot} onOpenCase={onOpenCase} onAct={onAct} />
          ))}
        </div>
      )}
    </section>
  );
}

function TaskRow({ slot, onOpenCase, onAct }) {
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
        {slot.status === '可交付' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) }), '已标记派发')}>标记派发</button>}
        {slot.status === '已派发' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已汇报' }) }), '已进入待核对')}>兼职已汇报</button>}
        {slot.status === '已汇报' && caze.douyinUrl && <a className="button" href={caze.douyinUrl} target="_blank">打开抖音</a>}
      </div>
    </div>
  );
}

function CasesView({ cases, onOpenCase, onNew }) {
  return (
    <section className="panel">
      <div className="sectionHead">
        <h2>案例库</h2>
        <button className="button primary" onClick={onNew}>新建案例</button>
      </div>
      {cases.length === 0 ? <div className="empty">还没有案例</div> : (
        <div className="caseGrid">
          {cases.map((item) => (
            <button key={item.id} className="caseTile" onClick={() => onOpenCase(item.id)}>
              <strong>{item.weixinNick}</strong>
              <span>{item.caseCode} · {item.project} · {item.stage}</span>
              <em>{item.douyinId || '未填抖音号'} · {item.healthStatus}</em>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function CaseDetail({ detail, onAct, onBack }) {
  const { case: caze, slots, candidates, assets, imageTasks, verifyTasks, metrics = [], materialGaps = [], healthReasons = [] } = detail;
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
              <SlotCard key={slot.id} slot={slot} candidates={candidatesBySlot[slot.id] || []} onAct={onAct} />
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
                  <p>{task.expectedPublishDate} · {task.resultNote || '等待打开抖音核对'}</p>
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

function SlotCard({ slot, candidates, onAct }) {
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
        <button onClick={() => onAct(() => request(`/slots/${slot.id}/generate-candidates`, { method: 'POST' }), '已生成候选')}>生成/重 roll</button>
        {selected && <button onClick={() => onAct(() => request(`/slots/${slot.id}/delivery`, { method: 'POST' }), '交付包已生成')}>生成交付包</button>}
        {slot.deliveryDir && <button onClick={() => onAct(() => request('/open-path', { method: 'POST', body: JSON.stringify({ path: slot.deliveryDir }) }), '已打开交付包')}>打开交付包</button>}
        {slot.status === '可交付' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已派发' }) }), '已派发')}>标记派发</button>}
        {slot.status === '已派发' && <button onClick={() => onAct(() => request(`/slots/${slot.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: '已汇报' }) }), '进入待核对')}>兼职已汇报</button>}
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
              <button onClick={() => onAct(() => request(`/candidates/${draft.id}/select`, { method: 'POST' }), '已锁定候选')}>{draft.selected ? '已选择' : '选择这条'}</button>
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
        <label className="wide">爆点结构<textarea value={form.hotStructure} onChange={(e) => update('hotStructure', e.target.value)} /></label>
      </div>
      <div className="modalActions">
        <button onClick={onClose}>取消</button>
        <button className="primary" onClick={() => onSubmit(form)}>保存</button>
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
