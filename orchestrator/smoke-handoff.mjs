#!/usr/bin/env node
/**
 * Step 4 smoke test — drives a conversation to maturity, triggers
 * propose_handoff, verifies state transition planning → plan_ready, and
 * then POST /build to confirm plan_ready → building.
 *
 * The test explicitly instructs the LLM to call propose_handoff so we
 * don't depend on its autonomous judgment (that behavior is exercised
 * manually through the UI).
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
const TEST_EMAIL = `smoke-handoff-${Date.now()}@test.local`;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 120000);

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

function waitForCompletion(socket, projectId, { onEventSeen } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      socket.off('agent_event', onEvent);
      reject(new Error(`timeout waiting for completion (got ${events.length} events)`));
    }, TIMEOUT_MS);

    const onEvent = (ev) => {
      if (ev.project_id !== projectId) return;
      events.push(ev);
      onEventSeen?.(ev);
      if (ev.event_type === 'token') {
        process.stdout.write(ev.payload?.delta ?? '');
      } else if (ev.event_type === 'tool_call') {
        process.stdout.write(`\n[🔧 ${ev.payload?.name}]\n`);
      } else if (ev.event_type === 'tool_result') {
        const r = ev.payload?.result ?? {};
        process.stdout.write(`[${r.ok === false ? '✗' : '✓'} ${ev.payload?.name}] ${JSON.stringify(r).slice(0, 160)}\n`);
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

  const db = new Database(DB_PATH);
  const userId = randomUUID();
  db.prepare(`
    INSERT INTO users (id, email, name, avatar_url, profile_is_developer, profile_explain_depth, created_at)
    VALUES (?, ?, ?, NULL, 0, 'detailed', datetime('now'))
  `).run(userId, TEST_EMAIL, 'Smoke Handoff');
  db.close();

  const token = jwt.sign(
    { sub: userId, id: userId, email: TEST_EMAIL },
    JWT_SECRET,
    { expiresIn: '1h' },
  );

  const project = await httpJson('POST', '/api/projects', token, {
    title: 'Step 4 — handoff smoke',
  });
  log('project', project.id);

  const socket = io(`${ORCH_URL}/ws`, { transports: ['websocket'] });
  await new Promise((r) => socket.on('connect', r));
  socket.emit('join', { projectId: project.id });
  log('ws joined');

  // ---- turn 1: minimal scope ----
  log('\n=== turn 1 — scope ===');
  await httpJson('POST', `/api/projects/${project.id}/chat/messages`, token, {
    content:
      '저는 아주 간단한 개인용 쇼핑 리스트 웹앱을 만들고 싶어요. ' +
      '주요 기능: 아이템 추가, 완료 체크, 삭제. 혼자 쓸 거고, 모바일 웹에서 주로 씁니다. ' +
      '대상 사용자는 저 개인입니다.',
  });
  await waitForCompletion(socket, project.id);

  // ---- turn 2: write PRD ----
  log('\n=== turn 2 — write PRD ===');
  await httpJson('POST', `/api/projects/${project.id}/chat/messages`, token, {
    content:
      '지금까지 내용으로 write_prd 툴을 호출해서 PRD.md를 짧게 저장해주세요. ' +
      '섹션에 [user-required] / [ai-fillable] 태그를 붙이세요.',
  });
  await waitForCompletion(socket, project.id);

  // ---- turn 3: propose_handoff ----
  log('\n=== turn 3 — propose_handoff ===');
  let handoffSeen = false;
  let transitionSeen = false;
  await httpJson('POST', `/api/projects/${project.id}/chat/messages`, token, {
    content:
      '기획이 충분히 정리됐다고 생각합니다. propose_handoff 툴을 호출해서 ' +
      'completeness 각 항목을 0.8 정도로 평가하고, unresolved_questions는 빈 배열로, ' +
      'assumptions_made에 당신이 임의로 결정한 것 한두 개를 적어주세요. ' +
      'tech_constraints에는 storage=SQLite, runtime=Node.js+Express 정도만.',
  });
  await waitForCompletion(socket, project.id, {
    onEventSeen: (ev) => {
      if (ev.event_type === 'tool_result' && ev.payload?.name === 'propose_handoff') {
        handoffSeen = true;
      }
      if (ev.event_type === 'progress' && ev.phase === 'plan_ready') {
        transitionSeen = true;
      }
    },
  });

  // ---- verify DB state ----
  console.log('\n---- verifications ----');
  const db2 = new Database(DB_PATH, { readonly: true });
  const proj = db2.prepare('SELECT state, current_session_id FROM projects WHERE id = ?').get(project.id);
  console.log(`project state: ${proj.state}`);
  const handoffs = db2.prepare('SELECT id, completeness, unresolved_questions FROM handoffs WHERE session_id = ?').all(proj.current_session_id);
  console.log(`handoffs: ${handoffs.length}`);
  for (const h of handoffs) console.log(`  ${h.id}  completeness=${h.completeness}  unresolved=${h.unresolved_questions}`);
  db2.close();

  if (!handoffSeen) {
    console.error('FAIL: agent never called propose_handoff');
    socket.disconnect();
    process.exit(2);
  }
  if (proj.state !== 'plan_ready') {
    console.error(`FAIL: state is ${proj.state}, expected plan_ready`);
    socket.disconnect();
    process.exit(2);
  }
  if (!transitionSeen) {
    console.error('WARN: progress/plan_ready event not observed (non-fatal)');
  }

  // ---- trigger build ----
  log('\n=== build click ===');
  const buildRes = await httpJson('POST', `/api/projects/${project.id}/build`, token);
  console.log('build response:', buildRes);

  // Allow time for state update to commit
  await new Promise((r) => setTimeout(r, 400));

  const db3 = new Database(DB_PATH, { readonly: true });
  const finalState = db3.prepare('SELECT state FROM projects WHERE id = ?').get(project.id).state;
  db3.close();
  console.log(`final state after build click: ${finalState}`);

  socket.disconnect();

  if (finalState !== 'building') {
    console.error(`FAIL: expected 'building', got '${finalState}'`);
    process.exit(3);
  }
  console.log('\nOK');
}

main().catch((err) => {
  console.error('FAIL:', err.message ?? err);
  process.exit(1);
});
