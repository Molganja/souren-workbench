import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT_DIR = path.resolve(process.cwd(), '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const MATERIAL_ROOT = path.join(ROOT_DIR, '素材库', '真实案例');
export const DB_PATH = path.join(DATA_DIR, 'souren.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MATERIAL_ROOT, { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  case_code TEXT NOT NULL UNIQUE,
  weixin_nick TEXT NOT NULL,
  douyin_id TEXT,
  douyin_url TEXT,
  project TEXT NOT NULL,
  stage TEXT NOT NULL,
  persona TEXT NOT NULL,
  staff TEXT,
  local_case_dir TEXT NOT NULL,
  health_status TEXT NOT NULL DEFAULT '健康',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan_slots (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  time_window TEXT,
  content_kind TEXT NOT NULL,
  goal TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  selected_candidate_id TEXT,
  delivery_dir TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidate_drafts (
  id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL REFERENCES plan_slots(id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  title TEXT NOT NULL,
  publish_text TEXT NOT NULL,
  operator_instruction TEXT NOT NULL,
  format TEXT NOT NULL,
  source_template_id TEXT,
  compliance_hits TEXT NOT NULL DEFAULT '[]',
  selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS viral_templates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  source_link TEXT,
  category TEXT NOT NULL,
  hot_structure TEXT NOT NULL,
  suitable_personas TEXT NOT NULL DEFAULT '[]',
  forbidden_personas TEXT NOT NULL DEFAULT '[]',
  rewrite_policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  source TEXT NOT NULL,
  usage TEXT NOT NULL,
  review_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(case_id, path)
);

CREATE TABLE IF NOT EXISTS image_tasks (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  plan_slot_id TEXT REFERENCES plan_slots(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  source_materials TEXT NOT NULL DEFAULT '[]',
  output_dir TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verify_tasks (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  plan_item_id TEXT NOT NULL REFERENCES plan_slots(id) ON DELETE CASCADE,
  douyin_url TEXT,
  expected_title TEXT,
  expected_publish_date TEXT,
  expected_assets TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  result_note TEXT,
  metrics_snapshot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  fans INTEGER,
  plays INTEGER,
  likes INTEGER,
  comments INTEGER,
  note TEXT,
  created_at TEXT NOT NULL
);
`);

export function now() {
  return new Date().toISOString();
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function all(sql, params = {}) {
  const statement = db.prepare(sql);
  return Array.isArray(params) ? statement.all(...params) : statement.all(params);
}

export function get(sql, params = {}) {
  const statement = db.prepare(sql);
  return Array.isArray(params) ? statement.get(...params) : statement.get(params);
}

export function run(sql, params = {}) {
  const statement = db.prepare(sql);
  return Array.isArray(params) ? statement.run(...params) : statement.run(params);
}

export function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function ensureCaseDirs(caseDir) {
  [
    '00-原始素材',
    '01-已筛选素材',
    '02-生成补充',
    '03-交付给兼职',
    '04-发布回收'
  ].forEach((name) => fs.mkdirSync(path.join(caseDir, name), { recursive: true }));
}

export function safeSegment(input) {
  return String(input || '')
    .trim()
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, '')
    .replace(/\s+/g, '')
    .slice(0, 24) || '未命名';
}
