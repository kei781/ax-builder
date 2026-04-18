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
  return lower;
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

    vars.push({
      key: varKey,
      tier,
      required,
      description: currentMeta['description'],
      issuance_guide: currentMeta['issuance'],
      example: currentMeta['example'],
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
