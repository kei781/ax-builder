#!/usr/bin/env node
/**
 * End-to-end smoke test for the Planning Agent chat flow.
 *
 * Requirements:
 *   - planning-agent/ running on 4100
 *   - orchestrator/ running on 4000
 *   - data/ax-builder.db accessible with the same schema as the orchestrator
 *
 * Flow:
 *   1. Insert a synthetic user into the DB (bypasses OAuth for the test).
 *   2. Sign a JWT using the orchestrator's JWT_SECRET.
 *   3. Create a project via POST /api/projects.
 *   4. Open a socket.io client to /ws and join project room.
 *   5. POST /api/projects/:id/chat/messages and wait for the 'completion' event.
 *   6. Print a compact summary of all events received.
 *
 * Exit codes:
 *   0 = completion received; non-zero = timeout or error event.
 */
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import * as fs from 'node:fs';

// Load env from repo root
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const ORCH_URL = process.env.ORCH_URL || 'http://127.0.0.1:4000';
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret';
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data/ax-builder.db');
const TEST_EMAIL = `smoke-${Date.now()}@test.local`;
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 60000);

function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}

async function httpJson(method, pathPart, token, body) {
  const res = await fetch(`${ORCH_URL}${pathPart}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${pathPart} → ${res.status}: ${JSON.stringify(data)}`,
    );
  }
  return data;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`DB not found at ${DB_PATH} — is orchestrator running?`);
  }

  // 1) insert user directly
  const db = new Database(DB_PATH);
  const userId = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, name, avatar_url, profile_is_developer, profile_explain_depth, created_at)
     VALUES (?, ?, ?, NULL, 0, 'detailed', datetime('now'))`,
  ).run(userId, TEST_EMAIL, 'Smoke Test');
  db.close();
  log('inserted user', userId, TEST_EMAIL);

  // 2) sign JWT
  const token = jwt.sign(
    { sub: userId, id: userId, email: TEST_EMAIL },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
  log('jwt signed');

  // 3) create project
  const project = await httpJson('POST', '/api/projects', token, {
    title: '스모크 테스트 프로젝트',
  });
  log('project created', project.id, 'state=', project.state);

  // 4) open WS
  const socket = io(`${ORCH_URL}/ws`, {
    transports: ['websocket'],
    auth: {},
  });

  const events = [];
  let completed = false;
  let errored = null;
  let tokensConcatenated = '';

  socket.on('connect', () => {
    log('ws connected sid=', socket.id);
    socket.emit('join', { projectId: project.id });
  });
  socket.on('agent_event', (ev) => {
    events.push(ev);
    if (ev.event_type === 'token') {
      const delta = ev.payload?.delta ?? '';
      tokensConcatenated += delta;
      process.stdout.write(delta);
    } else if (ev.event_type === 'progress') {
      log('progress', ev.payload?.detail ?? '');
    } else if (ev.event_type === 'log') {
      log('log', ev.payload?.kind, ev.payload?.content?.slice(0, 40));
    } else if (ev.event_type === 'completion') {
      process.stdout.write('\n');
      log(
        'completion',
        'content.length=',
        ev.payload?.content?.length ?? 0,
      );
      completed = true;
    } else if (ev.event_type === 'error') {
      process.stdout.write('\n');
      log('error', JSON.stringify(ev.payload));
      errored = ev.payload;
    }
  });

  // 5) wait for ws to join, then send message
  await new Promise((r) => setTimeout(r, 500));

  const messageText = '안녕하세요! 스모크 테스트입니다. 짧게 인사 부탁드립니다.';
  const sendResult = await httpJson(
    'POST',
    `/api/projects/${project.id}/chat/messages`,
    token,
    { content: messageText },
  );
  log('message posted', sendResult.message_id, 'session=', sendResult.session_id);

  // 6) wait for completion or error
  const deadline = Date.now() + TIMEOUT_MS;
  while (!completed && !errored && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  socket.disconnect();

  console.log('\n---- summary ----');
  console.log('events received:', events.length);
  const byType = {};
  for (const ev of events) byType[ev.event_type] = (byType[ev.event_type] ?? 0) + 1;
  console.log('by type:', byType);
  console.log('assistant length:', tokensConcatenated.length);

  if (errored) {
    console.error('FAIL: error event', errored);
    process.exit(2);
  }
  if (!completed) {
    console.error('FAIL: timed out waiting for completion');
    process.exit(3);
  }
  console.log('OK');
}

main().catch((err) => {
  console.error('FAIL:', err.message ?? err);
  process.exit(1);
});
