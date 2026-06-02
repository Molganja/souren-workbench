import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE = process.env.SOUREN_API_BASE || 'http://127.0.0.1:5174/api';
const execFileAsync = promisify(execFile);

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function numberFromChinese(value) {
  if (value == null) return null;
  const raw = String(value).replace(/,/g, '').trim();
  const match = raw.match(/([\d.]+)\s*([万wW千kK]?)/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = match[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(base * 10000);
  if (unit === '千' || unit === 'k' || unit === 'K') return Math.round(base * 1000);
  return Math.round(base);
}

function firstNumberNearLabel(text, labels = []) {
  const normalized = String(text || '').replace(/\s+/g, ' ');
  for (const label of labels) {
    const before = new RegExp(`([\\d,.]+\\s*(?:万|w|W|千|k|K)?)\\s*${label}`);
    const after = new RegExp(`${label}\\s*([\\d,.]+\\s*(?:万|w|W|千|k|K)?)`);
    const afterMatch = normalized.match(after);
    if (afterMatch) return numberFromChinese(afterMatch[1]);
    const beforeMatch = normalized.match(before);
    if (beforeMatch) return numberFromChinese(beforeMatch[1]);
  }
  return null;
}

function compactTitle(text, fallback = '') {
  const cleaned = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/展开|收起|评论|分享|收藏/g, '')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 80);
}

export function parseDouyinPage(page = {}) {
  const text = `${page.title || ''}\n${page.text || ''}`;
  const account = {
    fans: firstNumberNearLabel(text, ['粉丝']),
    following: firstNumberNearLabel(text, ['关注']),
    totalLikes: firstNumberNearLabel(text, ['获赞', '点赞']),
    totalWorks: firstNumberNearLabel(text, ['作品', '投稿'])
  };
  const videos = [];
  const seen = new Set();
  const links = Array.isArray(page.links) ? page.links : [];
  links.forEach((link) => {
    const href = String(link.href || '').trim();
    if (!/douyin\.com\/video\/|\/video\/|douyin\.com\/note\/|\/note\//.test(href)) return;
    const cleanHref = href.split('?')[0];
    if (seen.has(cleanHref)) return;
    seen.add(cleanHref);
    const linkText = String(link.text || '').trim();
    videos.push({
      url: cleanHref,
      title: compactTitle(linkText, compactTitle(page.title, '未命名作品')),
      plays: firstNumberNearLabel(linkText, ['播放']),
      likes: firstNumberNearLabel(linkText, ['点赞', '赞']),
      comments: firstNumberNearLabel(linkText, ['评论']),
      shares: firstNumberNearLabel(linkText, ['分享']),
      favorites: firstNumberNearLabel(linkText, ['收藏'])
    });
  });
  return {
    account,
    videos: videos.slice(0, 8),
    raw: {
      title: page.title || '',
      url: page.url || '',
      linkCount: links.length,
      textSample: String(page.text || '').slice(0, 1500)
    }
  };
}

function hasAnyMetric(parsed) {
  const accountValues = Object.values(parsed.account || {});
  const videoValues = (parsed.videos || []).flatMap((item) => [
    item.plays,
    item.likes,
    item.comments,
    item.shares,
    item.favorites
  ]);
  return [...accountValues, ...videoValues].some((value) => value != null);
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function chromePageScript() {
  return `(() => {
    const links = Array.from(document.querySelectorAll('a')).slice(0, 300).map((a) => ({
      href: a.href || '',
      text: (a.innerText || a.getAttribute('aria-label') || a.title || '').trim()
    }));
    const metas = Array.from(document.querySelectorAll('meta')).map((m) => ({
      name: m.getAttribute('name') || m.getAttribute('property') || '',
      content: m.getAttribute('content') || ''
    }));
    return JSON.stringify({
      url: location.href,
      title: document.title,
      text: document.body ? document.body.innerText : '',
      links,
      metas
    });
  })()`;
}

async function readChromePage(url, waitMs = 6000) {
  if (os.platform() !== 'darwin') {
    throw new Error('当前采集执行器只支持 macOS Google Chrome；其他系统先用采集清单和 ingest 接口写回。');
  }
  const waitSeconds = Math.max(1, Math.min(Number(waitMs) || 6000, 30000)) / 1000;
  const script = [
    'tell application "Google Chrome"',
    '  activate',
    '  if (count of windows) = 0 then make new window',
    `  set URL of active tab of front window to ${appleScriptString(url)}`,
    `  delay ${waitSeconds}`,
    `  set pageJson to execute active tab of front window javascript ${appleScriptString(chromePageScript())}`,
    'end tell',
    'return pageJson'
  ].join('\n');
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: Math.round(waitSeconds * 1000) + 15000
  });
  const output = stdout.trim();
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Chrome 页面读取失败：${error.message}`);
  }
}

async function api(base, pathname, options = {}) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${pathname}: ${data?.error || res.status}`);
  return data;
}

function payloadForTarget(target, parsed, page) {
  return {
    caseId: target.caseId,
    douyinUrl: target.douyinUrl,
    source: 'chrome-agent',
    collectedAt: new Date().toISOString(),
    account: parsed.account,
    videos: parsed.videos,
    note: `Chrome 自动采集：${page.title || target.douyinUrl}`
  };
}

export async function runCollector(options = {}) {
  const base = String(options.base || argValue('--base', DEFAULT_BASE)).replace(/\/$/, '');
  const limit = Number(options.limit ?? argValue('--limit', '10')) || 10;
  const waitMs = Number(options.waitMs ?? argValue('--wait-ms', '6000')) || 6000;
  const includeFresh = options.includeFresh ?? hasFlag('--include-fresh');
  const dryRun = options.dryRun ?? hasFlag('--dry-run');
  const register = options.register ?? hasFlag('--register');
  const print = options.print !== false;
  const queue = register
    ? await api(base, '/douyin-monitor/chrome-queue', {
      method: 'POST',
      body: JSON.stringify({ limit, includeFresh })
    })
    : await api(base, `/douyin-monitor/chrome-queue?limit=${limit}${includeFresh ? '&includeFresh=1' : ''}`);
  const results = [];
  for (const target of queue.targets || []) {
    try {
      const page = await readChromePage(target.douyinUrl, waitMs);
      const parsed = parseDouyinPage(page);
      const payload = payloadForTarget(target, parsed, page);
      if (!hasAnyMetric(parsed)) {
        results.push({
          caseId: target.caseId,
          weixinNick: target.weixinNick,
          status: 'skipped',
          reason: '页面没有解析到粉丝、作品或互动数据，未写回，避免伪造采集结果。'
        });
        continue;
      }
      if (dryRun) {
        results.push({ caseId: target.caseId, weixinNick: target.weixinNick, status: 'dry_run', payload });
        continue;
      }
      const ingest = await api(base, '/douyin-monitor/ingest', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      results.push({
        caseId: target.caseId,
        weixinNick: target.weixinNick,
        status: 'ingested',
        accountSnapshot: Boolean(ingest.accountSnapshot),
        videos: ingest.videos?.length || 0,
        videoSnapshots: ingest.videoSnapshots?.length || 0,
        viralAlerts: ingest.viralAlerts?.length || 0
      });
    } catch (error) {
      results.push({
        caseId: target.caseId,
        weixinNick: target.weixinNick,
        status: 'error',
        error: error.message
      });
    }
  }
  const summary = {
    ok: true,
    generatedAt: queue.generatedAt,
    count: queue.count,
    registeredCount: queue.registeredCount || 0,
    results
  };
  if (print) console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function selfTest() {
  const parsed = parseDouyinPage({
    url: 'https://www.douyin.com/user/test',
    title: '测试账号',
    text: '关注 128 粉丝 1.2万 获赞 36.5万 作品 88',
    links: [
      { href: 'https://www.douyin.com/video/123456?previous_page=app', text: '术后恢复记录 播放 2.3万 点赞 890 评论 76 收藏 12' },
      { href: 'https://www.douyin.com/video/123456?foo=bar', text: '重复链接' },
      { href: 'https://www.example.com/', text: '外链' }
    ]
  });
  assert(parsed.account.following === 128, 'following parse failed');
  assert(parsed.account.fans === 12000, 'fans parse failed');
  assert(parsed.account.totalLikes === 365000, 'likes parse failed');
  assert(parsed.account.totalWorks === 88, 'works parse failed');
  assert(parsed.videos.length === 1, 'video dedupe failed');
  assert(parsed.videos[0].plays === 23000, 'video plays parse failed');
  assert(parsed.videos[0].likes === 890, 'video likes parse failed');
  assert(parsed.videos[0].comments === 76, 'video comments parse failed');
  assert(hasAnyMetric(parsed), 'metric detection failed');
  console.log('OK Douyin Chrome collector self-test');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (hasFlag('--self-test')) {
    selfTest();
  } else {
    runCollector({ print: true }).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
  }
}
