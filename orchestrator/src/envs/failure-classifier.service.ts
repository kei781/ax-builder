import { Injectable, Logger } from '@nestjs/common';

/**
 * ADR 0002 — FailureClassifier.
 *
 * Classifies an env_qa failure so we route it to the right actor:
 *
 *   env_rejected → 유저의 env 값 문제 (재입력 유도)
 *   transient    → 외부 서비스 일시 장애 (재시도)
 *   code_bug     → 앱 코드 문제 (Planning bounce)
 *   schema_bug   → env 스키마가 잘못 정의됨 (Planning bounce, 변수 이력 첨부)
 *
 * MVP 구현: regex 룰 테이블 1차 매칭. LLM judge(`qa_judge` 슬롯)는
 * TODO로 남김 — 추가 복잡도 대비 상승폭이 작음. 미매칭 기본값은
 * `code_bug`(안전한 폴백, 유저를 재입력 지옥에 두지 않음).
 *
 * schema_bug 판정은 분류기 자체가 내리지 않는다. "env_rejected가
 * 같은 변수에서 3회 반복"은 `EnvDeployService`가 카운터로 관리하며,
 * 이 서비스는 단일 로그에 대한 분류만 담당.
 */
export type FailureKind =
  | 'env_rejected'
  | 'transient'
  | 'code_bug'
  | 'infra_error'
  | 'unknown';

export interface Classification {
  kind: FailureKind;
  /** 분류 근거 — UI에 "세부 보기"로 노출. */
  reason: string;
  /** 매칭한 regex 패턴 라벨. 통계용. */
  matched_rule: string | null;
}

interface Rule {
  label: string;
  pattern: RegExp;
  kind: FailureKind;
}

const RULES: Rule[] = [
  // --- infra_error: Claude Code CLI / 빌드 환경 자체 문제. ---
  //     유저나 AI가 재시도해도 풀리지 않는다. 운영자 개입 필요.
  //     env_rejected의 401보다 먼저 매칭해서 가려낸다.
  {
    label: 'claude-auth-failed',
    pattern: /(Failed to authenticate|authentication_error).*(401|Invalid authentication credentials)/is,
    kind: 'infra_error',
  },
  {
    label: 'claude-cli-not-found',
    pattern: /claude CLI not found|command not found: claude/i,
    kind: 'infra_error',
  },
  {
    label: 'claude-rate-limit',
    pattern: /rate[_\s-]?limit.*(exceeded|reached|429)/i,
    kind: 'infra_error',
  },
  {
    label: 'claude-context-overflow',
    pattern: /context[_\s-]?length[_\s-]?exceeded|maximum context length|prompt is too long/i,
    kind: 'infra_error',
  },
  {
    label: 'disk-full',
    pattern: /ENOSPC|No space left on device/i,
    kind: 'infra_error',
  },
  {
    label: 'oom',
    pattern: /OOMKilled|out of memory|ENOMEM|JavaScript heap out of memory/i,
    kind: 'infra_error',
  },
  {
    label: 'docker-daemon',
    pattern: /docker.*daemon|Is the docker daemon running/i,
    kind: 'infra_error',
  },

  // --- env_rejected: 유저 귀책 ---
  {
    label: 'http-401',
    pattern: /\b(401|unauthorized)\b/i,
    kind: 'env_rejected',
  },
  {
    label: 'http-403',
    pattern: /\b(403|forbidden)\b/i,
    kind: 'env_rejected',
  },
  {
    label: 'invalid-api-key',
    pattern: /invalid[_\s-]?(api[_\s-]?)?key/i,
    kind: 'env_rejected',
  },
  {
    label: 'api-key-not-found',
    pattern: /api[_\s-]?key[_\s]?(not found|missing|required)/i,
    kind: 'env_rejected',
  },
  {
    label: 'auth-failed',
    pattern: /auth(entication)?\s+(failed|error)/i,
    kind: 'env_rejected',
  },

  // --- transient: 아무도 안 책임짐, 재시도 ---
  {
    label: 'econnrefused',
    pattern: /ECONNREFUSED/,
    kind: 'transient',
  },
  {
    label: 'etimedout',
    pattern: /ETIMEDOUT/,
    kind: 'transient',
  },
  {
    label: 'enotfound',
    pattern: /ENOTFOUND/,
    kind: 'transient',
  },
  {
    label: 'http-502',
    pattern: /\b502\b/,
    kind: 'transient',
  },
  {
    label: 'http-503',
    pattern: /\b503\b|service unavailable/i,
    kind: 'transient',
  },

  // --- code_bug: 앱 코드 문제 ---
  {
    label: 'syntax-error',
    pattern: /SyntaxError/,
    kind: 'code_bug',
  },
  {
    label: 'type-error',
    pattern: /TypeError/,
    kind: 'code_bug',
  },
  {
    label: 'reference-error',
    pattern: /ReferenceError/,
    kind: 'code_bug',
  },
  {
    label: 'module-not-found',
    pattern: /Cannot find module|MODULE_NOT_FOUND/,
    kind: 'code_bug',
  },
  {
    label: 'node-crash',
    pattern: /node:.*fatal|Abort trap|Bus error/i,
    kind: 'code_bug',
  },
];

@Injectable()
export class FailureClassifierService {
  private readonly logger = new Logger(FailureClassifierService.name);

  classify(logs: string): Classification {
    if (!logs?.trim()) {
      return {
        kind: 'unknown',
        reason: '로그가 없어 원인을 특정할 수 없습니다.',
        matched_rule: null,
      };
    }

    // 우선순위: 파일 앞쪽(= 스택 원인) 말고 파일 끝쪽(= 실제 실패 라인) 쪽을
    // 선호. 하지만 regex 매칭은 전체 텍스트에 함. "뒤쪽 우선"은 같은 kind가
    // 여러 번 매칭될 때 마지막 것을 선택하는 방식으로 반영.
    let winner: { rule: Rule; index: number } | null = null;
    for (const rule of RULES) {
      const match = logs.match(rule.pattern);
      if (!match) continue;
      const idx = logs.lastIndexOf(match[0]);
      if (!winner || idx > winner.index) {
        winner = { rule, index: idx };
      }
    }

    if (!winner) {
      this.logger.warn('FailureClassifier: no rule matched, defaulting to code_bug');
      return {
        kind: 'code_bug',
        reason: '알려진 실패 패턴과 일치하지 않아 코드 버그로 간주했어요.',
        matched_rule: null,
      };
    }

    const { rule, index } = winner;
    const ctxStart = Math.max(0, index - 120);
    const ctxEnd = Math.min(logs.length, index + 200);
    const snippet = logs.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();

    return {
      kind: rule.kind,
      reason: `"${rule.label}" 패턴 매칭: ${snippet.slice(0, 240)}`,
      matched_rule: rule.label,
    };
  }
}
