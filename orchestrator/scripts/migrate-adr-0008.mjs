#!/usr/bin/env node
/**
 * ADR 0008 one-shot data migration.
 *
 * TypeORM은 synchronize=true로 entity 변경을 스키마에 반영하지만,
 * **기존 데이터 마이그레이션은 수동**이다. 이 스크립트는:
 *
 *   1. 기존 `modifying` 상태 row를 `planning_update`로 치환.
 *   2. (검증) 새 컬럼 previous_container_id / previous_version이
 *      projects 테이블에 존재하는지 확인 — 없으면 경고만 출력.
 *   3. (검증) project_versions.primary_endpoints 컬럼 존재 확인.
 *
 * 실행:
 *   node scripts/migrate-adr-0008.mjs
 *
 * 이 마이그레이션은 idempotent — 여러 번 실행해도 안전.
 */
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH =
  process.env.DB_PATH ||
  path.resolve(__dirname, '..', '..', 'data', 'ax-builder.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found at ${DB_PATH}`);
  console.error('orchestrator를 한 번 띄워 스키마를 생성한 뒤 다시 실행하세요.');
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

function columnExists(table, col) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === col);
}

// ---- 1. modifying → planning_update ----
const modifyingRows = db
  .prepare("SELECT id, title, state FROM projects WHERE state = 'modifying'")
  .all();
if (modifyingRows.length) {
  console.log(`Found ${modifyingRows.length} project(s) in 'modifying' state:`);
  for (const r of modifyingRows) console.log(`  - ${r.id} ${r.title}`);
  const res = db
    .prepare(
      "UPDATE projects SET state = 'planning_update', updated_at = CURRENT_TIMESTAMP WHERE state = 'modifying'",
    )
    .run();
  console.log(`Updated ${res.changes} row(s) → planning_update.`);
} else {
  console.log("No 'modifying' rows to migrate.");
}

// ---- 2. projects 테이블 새 컬럼 확인 ----
for (const col of ['previous_container_id', 'previous_version']) {
  if (columnExists('projects', col)) {
    console.log(`projects.${col}: present`);
  } else {
    console.warn(
      `projects.${col}: MISSING — orchestrator를 띄우면 synchronize가 추가합니다.`,
    );
  }
}

// ---- 3. project_versions.primary_endpoints 확인 ----
if (columnExists('project_versions', 'primary_endpoints')) {
  console.log('project_versions.primary_endpoints: present');
} else {
  console.warn(
    'project_versions.primary_endpoints: MISSING — orchestrator 재시작 필요.',
  );
}

// ---- 4. 무결성 체크: deployed 상태인데 container_id 없는 건 불변식 위반 ----
const orphanDeployed = db
  .prepare(
    "SELECT id, title FROM projects WHERE state = 'deployed' AND container_id IS NULL",
  )
  .all();
if (orphanDeployed.length) {
  console.warn(
    `⚠ ${orphanDeployed.length} project(s) in 'deployed' without container_id:`,
  );
  for (const r of orphanDeployed) console.warn(`  - ${r.id} ${r.title}`);
  console.warn('  이 프로젝트들은 업데이트 라인에서 롤백 불가. 수동 점검 필요.');
}

db.close();
console.log('\n✓ ADR 0008 migration done.');
