/**
 * Parser for `.env.example` per PRD §9.2.
 *
 * Each variable block is a contiguous set of `#` comment lines followed by
 * `KEY=` (value ignored). Metadata we extract from comments (tolerant of
 * Korean/English keys and casing):
 *
 *   - 설명 / description
 *   - 발급 방법 / issuance / how
 *   - 예시 / example
 *   - 필수 여부 / required (values: required | optional)
 *   - 주입 / injection / tier / source
 *       values: system-injected | user-required | user-optional
 *
 * Missing `주입:` defaults to `user-required` (safe side — user sees it).
 *
 * Provider-key guard (ADR 0004): if a recognised provider key identifier
 * is marked user-required or user-optional, we reject — these must go
 * through the AI Gateway.
 */

import type { EnvTier } from './entities/project-env-var.entity.js';

export interface ParsedEnvVar {
  key: string;
  tier: EnvTier;
  required: boolean;
  description?: string;
  issuance_guide?: string;
  example?: string;
  /** ADR 0006 — `# 패턴:` regex metaline. Undefined = no pattern check. */
  validation_pattern?: string;
  /** ADR 0006 — `# 길이:` metaline, numeric bounds. */
  min_length?: number;
  max_length?: number;
}

export class EnvParseError extends Error {
  constructor(
    message: string,
    public readonly offending_keys?: string[],
  ) {
    super(message);
    this.name = 'EnvParseError';
  }
}

const PROVIDER_KEY_PATTERNS = [
  /^ANTHROPIC_API_KEY$/,
  /^OPENAI_API_KEY$/,
  /^GEMINI_API_KEY$/,
  /^GOOGLE_API_KEY$/,
  /^GOOGLE_GENERATIVE_AI_API_KEY$/,
  /^AZURE_OPENAI_(API_)?KEY$/,
  /^COHERE_API_KEY$/,
  /^MISTRAL_API_KEY$/,
];

function normalizeMetaKey(raw: string): string {
  const lower = raw.trim().toLowerCase();
  // Korean aliases
  if (['설명', 'desc', 'description'].includes(lower)) return 'description';
  if (['발급 방법', '발급방법', '발급', 'issuance', 'how', 'how to issue'].includes(lower))
    return 'issuance';
  if (['예시', 'example', 'sample'].includes(lower)) return 'example';
  if (['필수 여부', '필수', 'required'].includes(lower)) return 'required';
  if (['주입', '주입 방식', 'source', 'tier', 'kind', 'injection'].includes(lower))
    return 'tier';
  if (['패턴', '형식', 'pattern', 'regex', 'format'].includes(lower)) return 'pattern';
  if (['길이', 'length', 'len'].includes(lower)) return 'length';
  return lower;
}

/**
 * Parse a `# 길이:` value like "10-500" / "10~500" / ">=10" / "<=500" / "32".
 * Returns [min|undefined, max|undefined].
 */
function parseLength(raw: string): [number | undefined, number | undefined] {
  const s = raw.trim();
  // Range form: "10-500" or "10~500"
  const range = s.match(/^\s*(\d+)\s*[-~]\s*(\d+)\s*$/);
  if (range) return [Number(range[1]), Number(range[2])];
  // Bounds form
  const ge = s.match(/^>=?\s*(\d+)$/);
  if (ge) return [Number(ge[1]), undefined];
  const le = s.match(/^<=?\s*(\d+)$/);
  if (le) return [undefined, Number(le[1])];
  // Single number = exact length on both sides
  const n = s.match(/^(\d+)$/);
  if (n) return [Number(n[1]), Number(n[1])];
  return [undefined, undefined];
}

function parseTier(raw: string): EnvTier | null {
  const v = raw.trim().toLowerCase().replace(/[_\s]/g, '-');
  if (v === 'system-injected' || v === 'system') return 'system-injected';
  if (v === 'user-required' || v === 'required') return 'user-required';
  if (v === 'user-optional' || v === 'optional') return 'user-optional';
  return null;
}

export function parseEnvExample(content: string): ParsedEnvVar[] {
  const lines = content.split(/\r?\n/);
  const vars: ParsedEnvVar[] = [];
  let currentMeta: Record<string, string> = {};

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      // Blank line resets comment block (but only if no KEY= came)
      currentMeta = {};
      continue;
    }
    if (line.startsWith('#')) {
      const body = line.slice(1).trim();
      const colon = body.indexOf(':');
      if (colon === -1) {
        // Section header or bare comment — ignore
        continue;
      }
      const key = normalizeMetaKey(body.slice(0, colon));
      const val = body.slice(colon + 1).trim();
      if (key) currentMeta[key] = val;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const varKey = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(varKey)) continue;

    const parsedTier = currentMeta['tier']
      ? parseTier(currentMeta['tier'])
      : null;
    const tier: EnvTier = parsedTier ?? 'user-required';
    const required = (currentMeta['required'] ?? 'required')
      .toLowerCase()
      .includes('required')
      ? true
      : currentMeta['required']?.toLowerCase().includes('optional')
        ? false
        : tier !== 'user-optional';

    const [minLen, maxLen] = currentMeta['length']
      ? parseLength(currentMeta['length'])
      : [undefined, undefined];

    vars.push({
      key: varKey,
      tier,
      required,
      description: currentMeta['description'],
      issuance_guide: currentMeta['issuance'],
      example: currentMeta['example'],
      validation_pattern: currentMeta['pattern']?.trim() || undefined,
      min_length: minLen,
      max_length: maxLen,
    });
    currentMeta = {};
  }

  return vars;
}

/**
 * ADR 0004 guard. Returns the list of offending var names (empty = clean).
 * Provider keys *must* be system-injected (gateway-backed) — never exposed
 * to the user.
 */
export function findProviderKeyViolations(vars: ParsedEnvVar[]): string[] {
  const offending: string[] = [];
  for (const v of vars) {
    if (v.tier === 'system-injected') continue;
    if (PROVIDER_KEY_PATTERNS.some((p) => p.test(v.key))) {
      offending.push(v.key);
    }
  }
  return offending;
}

/** ADR 0006 — runtime validation of a single submitted value. */
export interface ValidationError {
  key: string;
  reason: 'pattern_mismatch' | 'too_short' | 'too_long' | 'required_empty';
  hint?: string;
}

export function validateValue(
  key: string,
  value: string,
  rules: {
    required?: boolean;
    validation_pattern?: string | null;
    min_length?: number | null;
    max_length?: number | null;
    example?: string | null;
  },
): ValidationError | null {
  const v = value ?? '';
  if (rules.required && v.trim().length === 0) {
    return { key, reason: 'required_empty', hint: '빈 값은 허용되지 않습니다.' };
  }
  // Empty optional — skip further checks
  if (v.length === 0) return null;

  if (rules.min_length != null && v.length < rules.min_length) {
    return {
      key,
      reason: 'too_short',
      hint: `최소 ${rules.min_length}자 이상이어야 합니다.`,
    };
  }
  if (rules.max_length != null && v.length > rules.max_length) {
    return {
      key,
      reason: 'too_long',
      hint: `최대 ${rules.max_length}자까지 허용됩니다.`,
    };
  }
  if (rules.validation_pattern) {
    try {
      const re = new RegExp(rules.validation_pattern);
      if (!re.test(v)) {
        return {
          key,
          reason: 'pattern_mismatch',
          hint: rules.example ? `예: ${rules.example}` : '형식이 올바르지 않습니다.',
        };
      }
    } catch {
      // Malformed pattern — ignore (Claude Code bug, don't block user)
    }
  }
  return null;
}
