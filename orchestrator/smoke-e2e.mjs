#!/usr/bin/env node
/**
 * Step 5 E2E smoke test — drives the full lifecycle:
 *   Planning (3 turns → PRD → handoff → plan_ready)
 *   Building (POST /build → wait for deployed/bounced)
 *
 * WARNING: this test invokes Claude CLI and may consume Claude quota.
 * It runs once for validation; avoid repeated invocations.
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
const TIMEOUT_PLANNING_MS = 120_000;
const TIMEOUT_BUILD_MS = 900_000; // Building can take many minutes

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function http(method, p, token, body) {
  const res = await fetch(`${ORCH_URL}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function waitFor(socket, projectId, predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => {
      socket.off('agent_event', handler);
      reject(new Error(`timeout (${events.length} events)\n${events.map(e => e.event_type).join(',')}`));
    }, timeoutMs);
    const handler = (ev) => {
      if (ev.project_id !== projectId) return;
      events.push(ev);
      // Log building events concisely
      if (ev.agent === 'building') {
        if (ev.event_type === 'phase_start') process.stdout.write(`\n=== Phase: ${ev.phase} ===\n`);
        else if (ev.event_type === 'phase_end') {
          const ok = ev.payload?.ok; const dur = ev.payload?.duration_s ?? '?';
          process.stdout.write(`${ok ? '✓' : '✗'} ${ev.phase} (${dur}s)\n`);
        } else if (ev.event_type === 'progress') process.stdout.write(`▸ ${ev.payload?.detail ?? ev.phase ?? ''}\n`);
        else if (ev.event_type === 'log') { /* skip verbose */ }
        else if (ev.event_type === 'error') process.stdout.write(`⚠ ${ev.payload?.message ?? ''}\n`);
        else if (ev.event_type === 'completion') process.stdout.write(`✓ ${ev.payload?.detail ?? 'done'}\n`);
      }
      // Planning tokens
      if (ev.agent === 'planning' && ev.event_type === 'token') process.stdout.write(ev.payload?.delta ?? '');
      if (ev.agent === 'planning' && ev.event_type === 'completion') process.stdout.write('\n');
      if (predicate(ev, events)) {
        clearTimeout(timer);
        socket.off('agent_event', handler);
        resolve(events);
      }
    };
    socket.on('agent_event', handler);
  });
}

async function main() {
  // Setup
  const db = new Database(DB_PATH);
  const userId = randomUUID();
  db.prepare(`INSERT INTO users (id, email, name, avatar_url, profile_is_developer, profile_explain_depth, created_at)
     VALUES (?, ?, ?, NULL, 0, 'detailed', datetime('now'))`).run(userId, `e2e-${Date.now()}@test.local`, 'E2E Test');
  db.close();
  const token = jwt.sign({ sub: userId, id: userId, email: `e2e-${Date.now()}@test.local` }, JWT_SECRET, { expiresIn: '2h' });
  const project = await http('POST', '/api/projects', token, { title: 'E2E 카운터 앱' });
  log('project', project.id);

  const socket = io(`${ORCH_URL}/ws`, { transports: ['websocket'] });
  await new Promise(r => socket.on('connect', r));
  socket.emit('join', { projectId: project.id });

  // ---- Planning ----
  log('\n====== PLANNING ======');

  const chatAndWait = async (msg) => {
    await http('POST', `/api/projects/${project.id}/chat/messages`, token, { content: msg });
    return waitFor(socket, project.id,
      (ev) => ev.agent === 'planning' && (ev.event_type === 'completion' || ev.event_type === 'error'),
      TIMEOUT_PLANNING_MS);
  };

  log('turn 1 — scope');
  await chatAndWait(
    '숫자를 세는 아주 간단한 카운터 앱을 만들고 싶어요. ' +
    '화면 가운데 큰 숫자가 있고, +1 버튼과 리셋 버튼만 있으면 됩니다. 혼자 쓸 거예요.'
  );

  log('turn 2 — write PRD + propose_handoff');
  await chatAndWait(
    '좋아요, 이 정도면 충분해요. ' +
    'write_prd로 PRD를 저장하고, propose_handoff를 호출해주세요. ' +
    'completeness 각 항목은 0.8으로, unresolved_questions는 빈 배열, ' +
    'tech_constraints에 storage=SQLite, runtime=Node.js+Express 넣어주세요.'
  );

  // Verify state transition
  const db2 = new Database(DB_PATH, { readonly: true });
  const proj = db2.prepare('SELECT state FROM projects WHERE id = ?').get(project.id);
  db2.close();
  if (proj.state !== 'plan_ready') {
    throw new Error(`Expected plan_ready, got ${proj.state}`);
  }
  log(`state: ${proj.state} ✓`);

  // ---- Building ----
  log('\n====== BUILDING ======');
  const buildRes = await http('POST', `/api/projects/${project.id}/build`, token);
  log(`build started: ${buildRes.build_id}`);

  // Wait for building to complete/fail/bounce
  await waitFor(socket, project.id,
    (ev) => ev.agent === 'building' && (
      ev.event_type === 'completion' ||
      (ev.event_type === 'error' && ev.payload?.kind !== 'phase_failure') ||
      (ev.event_type === 'progress' && ev.phase === 'bounce_back')
    ),
    TIMEOUT_BUILD_MS);

  socket.disconnect();

  // ---- Verify ----
  console.log('\n====== VERIFICATION ======');
  const db3 = new Database(DB_PATH, { readonly: true });
  const finalProject = db3.prepare('SELECT state, current_version FROM projects WHERE id = ?').get(project.id);
  const builds = db3.prepare('SELECT id, status, bounce_reason_gap_list FROM builds WHERE project_id = ?').all(project.id);
  const phases = db3.prepare(`
    SELECT bp.name, bp.status, bp.idx FROM build_phases bp
    JOIN builds b ON b.id = bp.build_id WHERE b.project_id = ?
    ORDER BY bp.idx
  `).all(project.id);
  db3.close();

  console.log(`final state: ${finalProject.state}`);
  console.log(`version: ${finalProject.current_version}`);
  console.log(`builds: ${builds.length}`);
  for (const b of builds) console.log(`  ${b.id} status=${b.status} ${b.bounce_reason_gap_list ? 'gaps=' + b.bounce_reason_gap_list.slice(0, 200) : ''}`);
  console.log(`phases: ${phases.length}`);
  for (const p of phases) console.log(`  ${p.idx} ${p.name} ${p.status}`);

  // Check files
  const projectDir = path.join(PROJECTS_BASE, project.id);
  const prdExists = fs.existsSync(path.join(projectDir, 'PRD.md'));
  const pkgExists = fs.existsSync(path.join(projectDir, 'package.json'));
  console.log(`PRD.md: ${prdExists}`);
  console.log(`package.json: ${pkgExists}`);

  if (finalProject.state === 'deployed') {
    console.log('\n✓ FULL E2E PASS — deployed');
  } else if (finalProject.state === 'planning') {
    console.log('\nBOUNCE-BACK — returned to planning (acceptable in MVP)');
  } else {
    console.log(`\nFINAL STATE: ${finalProject.state} (check logs)`);
  }
}

main().catch((err) => {
  console.error('FAIL:', err.message ?? err);
  process.exit(1);
});
