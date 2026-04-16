#!/usr/bin/env node
/**
 * Step 3 smoke test — drives Planning Agent tools end-to-end.
 *
 * Scenarios covered:
 *   1. Multi-turn conversation that forces `update_memory` + `search_memory`
 *   2. Prompt nudging the agent to call `write_prd`, then verify the file
 *      exists on disk.
 *   3. Agent-side DB write is visible from the orchestrator DB.
 *
 * This is not a strict test (no assertions on LLM wording), but it surfaces
 * regressions: tool dispatch broken, filesystem permissions wrong,
 * SQLite concurrent-write issue, event wiring broken.
 */
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const ORCH_URL = process.env.ORCH_URL || 'http://127.0.0.1:4000';
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret';
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data/ax-builder.db');
const PROJECTS_BASE = process.env.PROJECTS_BASE_DIR || path.join(ROOT, 'projects');
const TEST_EMAIL = `smoke-tools-${Date.now()}@test.local`;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000);

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function httpJson(method, p, token, body) {
  const res = await fetch(`${ORCH_URL}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function waitForCompletion(socket, projectId) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      socket.off('agent_event', onEvent);
      reject(new Error(`timeout waiting for completion (got ${events.length} events)`));
    }, TIMEOUT_MS);

    const onEvent = (ev) => {
      if (ev.project_id !== projectId) return;
      events.push(ev);
      if (ev.event_type === 'token') {
        process.stdout.write(ev.payload?.delta ?? '');
      } else if (ev.event_type === 'tool_call') {
        process.stdout.write(`\n[🔧 ${ev.payload?.name}(${ev.payload?.arguments?.slice(0, 80) ?? ''}...)]\n`);
      } else if (ev.event_type === 'tool_result') {
        const r = ev.payload?.result ?? {};
        process.stdout.write(`[${r.ok === false ? '✗' : '✓'} ${ev.payload?.name}] ${JSON.stringify(r).slice(0, 120)}\n`);
      } else if (ev.event_type === 'completion') {
        process.stdout.write('\n');
        clearTimeout(timer);
        socket.off('agent_event', onEvent);
        resolve(events);
      } else if (ev.event_type === 'error') {
        process.stdout.write('\n');
        clearTimeout(timer);
        socket.off('agent_event', onEvent);
        reject(new Error(`agent error: ${JSON.stringify(ev.payload)}`));
      }
    };
    socket.on('agent_event', onEvent);
  });
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`DB not found at ${DB_PATH} — start orchestrator first`);
  }

  // 1) insert user + sign JWT
  const db = new Database(DB_PATH);
  const userId = randomUUID();
  db.prepare(`
    INSERT INTO users (id, email, name, avatar_url, profile_is_developer, profile_explain_depth, created_at)
    VALUES (?, ?, ?, NULL, 0, 'detailed', datetime('now'))
  `).run(userId, TEST_EMAIL, 'Smoke Tools');
  db.close();

  const token = jwt.sign(
    { sub: userId, id: userId, email: TEST_EMAIL },
    JWT_SECRET,
    { expiresIn: '1h' },
  );

  // 2) create project
  const project = await httpJson('POST', '/api/projects', token, {
    title: 'Step 3 — tools smoke',
  });
  log('project', project.id);

  // 3) connect WS
  const socket = io(`${ORCH_URL}/ws`, { transports: ['websocket'] });
  await new Promise((r) => socket.on('connect', r));
  socket.emit('join', { projectId: project.id });
  log('ws joined');

  // ---- turn 1: introduce an idea + update_memory ----
  log('\n=== turn 1 — intro ===');
  await httpJson('POST', `/api/projects/${project.id}/chat/messages`, token, {
    content:
      '저는 쇼핑 리스트 웹앱을 만들고 싶어요. 혼자 쓸 것이고, 핸드폰에서 주로 쓸 거예요. ' +
      '이 내용들을 기억해주세요(target_users, platform).',
  });
  await waitForCompletion(socket, project.id);

  // ---- turn 2: force PRD write ----
  log('\n=== turn 2 — ask for PRD ===');
  await httpJson('POST', `/api/projects/${project.id}/chat/messages`, token, {
    content:
      '위 내용 기반으로 아주 짧게라도 PRD.md를 write_prd 툴로 저장해주세요. ' +
      '세부사항은 추후 대화로 보완하겠습니다.',
  });
  await waitForCompletion(socket, project.id);

  // ---- turn 3: verify memory recall ----
  log('\n=== turn 3 — recall memory ===');
  await httpJson('POST', `/api/projects/${project.id}/chat/messages`, token, {
    content: '아까 기억해달라고 한 내용을 search_memory로 확인하고 요약해주세요.',
  });
  await waitForCompletion(socket, project.id);

  socket.disconnect();

  // ---- verify side effects ----
  console.log('\n---- verifications ----');
  const prdPath = path.join(PROJECTS_BASE, project.id, 'PRD.md');
  const prdExists = fs.existsSync(prdPath);
  console.log(`PRD.md exists: ${prdExists} (${prdPath})`);
  if (prdExists) {
    const prd = fs.readFileSync(prdPath, 'utf-8');
    console.log(`PRD.md bytes: ${prd.length}`);
    console.log(`PRD.md preview:\n${prd.slice(0, 200)}${prd.length > 200 ? '…' : ''}`);
  }

  const db2 = new Database(DB_PATH, { readonly: true });
  const memRows = db2.prepare(
    'SELECT key, value FROM project_memory WHERE project_id = ?',
  ).all(project.id);
  console.log(`project_memory rows: ${memRows.length}`);
  for (const r of memRows) console.log(`  ${r.key} = ${r.value.slice(0, 100)}`);

  const logRows = db2.prepare(
    `SELECT event_type, json_extract(payload, '$.name') as name
     FROM agent_logs WHERE project_id = ? ORDER BY created_at`,
  ).all(project.id);
  console.log(`agent_logs rows: ${logRows.length}`);
  for (const r of logRows) console.log(`  ${r.event_type}  ${r.name ?? ''}`);
  db2.close();

  if (!prdExists) {
    console.error('FAIL: PRD.md was not created');
    process.exit(2);
  }
  console.log('\nOK');
}

main().catch((err) => {
  console.error('FAIL:', err.message ?? err);
  process.exit(1);
});
