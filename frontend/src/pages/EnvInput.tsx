import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import client from '../api/client';

/**
 * DESIGN.md §4 — env input for ax-builder projects.
 *
 * 2-mode (ADR 0006):
 *   - setup (project.state === 'awaiting_env'): 레거시, 원샷 입력.
 *   - maintenance (project.state === 'deployed' or 'env_qa'): 필드별 독립
 *     편집, [저장] / [저장 후 재시작] 2버튼.
 *
 * FailureClassifier(ADR 0002) verdict는 WS `error` 이벤트로 수신 → Banner 노출.
 */

interface EnvVarView {
  key: string;
  tier: 'system-injected' | 'user-required' | 'user-optional';
  required: boolean;
  description: string | null;
  issuance_guide: string | null;
  example: string | null;
  has_value: boolean;
  masked_preview: string | null;
  validation_pattern: string | null;
  min_length: number | null;
  max_length: number | null;
}

type FailureKind =
  | 'env_rejected'
  | 'transient'
  | 'code_bug'
  | 'schema_bug'
  | 'unknown';

interface FailureVerdict {
  kind: FailureKind;
  message: string;
  matched_rule: string | null;
  reason_snippet: string | null;
  next_state: string;
}

type Mode = 'setup' | 'maintenance';

interface ServerValidationError {
  key: string;
  reason: string;
  hint?: string;
}

const FAILURE_COPY: Record<FailureKind, { title: string; tone: 'warn' | 'info' | 'error' }> = {
  env_rejected: { title: '입력하신 값이 거부됐어요', tone: 'warn' },
  transient:    { title: '외부 서비스 응답이 없어요', tone: 'info' },
  code_bug:     { title: '앱 코드에 문제가 있어요', tone: 'error' },
  schema_bug:   { title: '환경변수 정의 자체에 문제가 있어요', tone: 'error' },
  unknown:      { title: '원인을 특정하지 못했어요', tone: 'error' },
};

function modeFromState(state: string): Mode {
  return state === 'awaiting_env' ? 'setup' : 'maintenance';
}

/** Local validation — mirrors orchestrator/src/envs/env-parser.ts `validateValue`. */
function validateLocal(
  v: EnvVarView,
  value: string,
): { ok: true } | { ok: false; hint: string } {
  const x = value ?? '';
  if (v.tier === 'user-required' && v.required && x.trim().length === 0) {
    return { ok: false, hint: '필수값입니다.' };
  }
  if (x.length === 0) return { ok: true };
  if (v.min_length != null && x.length < v.min_length) {
    return { ok: false, hint: `최소 ${v.min_length}자 이상이어야 해요.` };
  }
  if (v.max_length != null && x.length > v.max_length) {
    return { ok: false, hint: `최대 ${v.max_length}자까지 허용돼요.` };
  }
  if (v.validation_pattern) {
    try {
      const re = new RegExp(v.validation_pattern);
      if (!re.test(x)) {
        return {
          ok: false,
          hint: v.example ? `예: ${v.example}` : '형식이 올바르지 않아요.',
        };
      }
    } catch {
      // 서버가 잘못된 regex를 내려줘도 유저 입력 막지 않음
    }
  }
  return { ok: true };
}

export default function EnvInput() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [vars, setVars] = useState<EnvVarView[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<string>('awaiting_env');
  const [showOptional, setShowOptional] = useState(false);
  const [verdict, setVerdict] = useState<FailureVerdict | null>(null);
  const [showReason, setShowReason] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const mode = modeFromState(state);

  const loadAll = async () => {
    if (!id) return;
    try {
      const [g, p] = await Promise.all([
        client.get(`/projects/${id}/env/guide`),
        client.get(`/projects/${id}`),
      ]);
      setVars(g.data.vars);
      setState(p.data.state);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? '환경변수 목록을 불러오지 못했어요.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // WS subscription
  useEffect(() => {
    if (!id) return;
    const socket = io('/ws', { transports: ['polling', 'websocket'] });
    socketRef.current = socket;
    socket.on('connect', () => {
      socket.emit('join', { projectId: id });
    });
    socket.on('agent_event', async (event: { event_type: string; project_id: string; payload?: Record<string, unknown> }) => {
      if (event.project_id !== id) return;
      if (event.event_type === 'error' && event.payload?.kind === 'env_qa_failure') {
        const p = event.payload;
        setVerdict({
          kind: (p.classifier as FailureKind) ?? 'unknown',
          message: (p.message as string) ?? '실패했어요.',
          matched_rule: (p.matched_rule as string | null) ?? null,
          reason_snippet: (p.reason_snippet as string | null) ?? null,
          next_state: (p.next_state as string) ?? 'deployed',
        });
        setSubmitting(false);
        await loadAll();
        if (p.next_state === 'planning' || p.next_state === 'planning_update') {
          setTimeout(() => navigate(`/projects/${id}/chat`), 2500);
        }
      } else if (event.event_type === 'completion') {
        setToast('적용 완료');
        setSubmitting(false);
        setVerdict(null);
        await loadAll();
        setTimeout(() => setToast(null), 2500);
      }
    });
    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, navigate]);

  // Safety fallback state poll during env_qa
  useEffect(() => {
    if (state !== 'env_qa') return;
    const iv = setInterval(async () => {
      if (!id) return;
      try {
        const r = await client.get(`/projects/${id}`);
        if (r.data.state !== state) {
          setState(r.data.state);
          if (r.data.state === 'deployed') setSubmitting(false);
        }
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [state, id]);

  const required = useMemo(() => vars.filter((v) => v.tier === 'user-required'), [vars]);
  const optional = useMemo(() => vars.filter((v) => v.tier === 'user-optional'), [vars]);

  // For setup mode: required fields must all be filled
  const missingRequired = required.filter(
    (v) => v.required && !v.has_value && !values[v.key]?.trim(),
  );
  const hasLocalErrors = [...required, ...optional].some((v) => {
    const val = values[v.key];
    if (val == null) return false; // not touched — skip
    return !validateLocal(v, val).ok;
  });

  const canSubmit = (() => {
    if (submitting || state === 'env_qa') return false;
    if (hasLocalErrors) return false;
    if (mode === 'setup') return missingRequired.length === 0;
    return true; // maintenance: any state is fine (optional values may be blank)
  })();

  const submit = async (apply: boolean) => {
    if (!id) return;
    setSubmitting(true);
    setError(null);
    setVerdict(null);
    setServerErrors({});
    const payload = Object.entries(values)
      .filter(([, v]) => v != null) // include empty strings intentionally (clear)
      .map(([key, value]) => ({ key, value }));
    try {
      const res = await client.put(`/projects/${id}/env`, { vars: payload, apply });
      if (res.data?.restarting) {
        setState('env_qa');
        setToast('재시작 중...');
      } else {
        setToast('저장됐어요');
        setSubmitting(false);
        setValues({});
        await loadAll();
        setTimeout(() => setToast(null), 2000);
      }
    } catch (e: any) {
      setSubmitting(false);
      const data = e?.response?.data;
      const errs = (data?.errors ?? data?.message?.errors) as ServerValidationError[] | undefined;
      if (Array.isArray(errs)) {
        const m: Record<string, string> = {};
        for (const err of errs) m[err.key] = err.hint ?? err.reason;
        setServerErrors(m);
        setError('입력 형식을 확인해주세요.');
      } else {
        setError(typeof data?.message === 'string' ? data.message : '저장 실패');
      }
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <p className="text-gray-500">불러오는 중...</p>
      </div>
    );
  }

  const mockBanner = mode === 'maintenance' && required.some((v) => !v.has_value);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <header className="border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center gap-4">
        <a href="/" className="text-gray-500 hover:text-gray-900 dark:hover:text-white">
          ← 대시보드
        </a>
        <h1 className="text-gray-900 dark:text-white font-medium">환경 설정</h1>
        {state === 'env_qa' && (
          <span className="text-xs px-2 py-1 rounded-full bg-purple-500/10 text-purple-400">
            적용 중...
          </span>
        )}
        {mode === 'maintenance' && state === 'deployed' && (
          <span className="text-xs px-2 py-1 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
            🟢 운영 중
          </span>
        )}
      </header>

      <main className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-gray-700 dark:text-gray-300 mb-6">
          {mode === 'setup'
            ? '이 앱을 실행하려면 아래 값이 필요해요.'
            : '필요할 때 값을 넣으면 실제 기능이 활성화돼요.'}
        </p>

        {mockBanner && (
          <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-4 mb-6 text-sm text-orange-700 dark:text-orange-300">
            ⚠ 일부 기능이 mock 응답으로 동작 중이에요. 아래 필수 값을 입력하고 재시작하면 실제 기능으로 전환돼요.
          </div>
        )}

        {toast && (
          <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-3 mb-6 text-sm text-green-700 dark:text-green-400">
            ✓ {toast}
          </div>
        )}

        {error && !verdict && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6 text-sm text-red-500">
            {error}
          </div>
        )}

        {verdict && (
          <FailureBanner
            verdict={verdict}
            showReason={showReason}
            onToggleReason={() => setShowReason((s) => !s)}
            onRetry={() => submit(true)}
            onGoPlanning={() => id && navigate(`/projects/${id}/chat`)}
          />
        )}

        {required.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-4">
              필수
            </h2>
            <div className="space-y-6">
              {required.map((v) => (
                <EnvField
                  key={v.key}
                  v={v}
                  value={values[v.key] ?? ''}
                  onChange={(val) => setValues((prev) => ({ ...prev, [v.key]: val }))}
                  serverError={serverErrors[v.key]}
                  disabled={submitting || state === 'env_qa'}
                />
              ))}
            </div>
          </section>
        )}

        {optional.length > 0 && (
          <section className="mb-10">
            <button
              type="button"
              className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-white mb-4"
              onClick={() => setShowOptional((s) => !s)}
            >
              <span>{showOptional ? '▾' : '▸'}</span>
              <span>선택 ({optional.length})</span>
            </button>
            {showOptional && (
              <div className="space-y-6">
                {optional.map((v) => (
                  <EnvField
                    key={v.key}
                    v={v}
                    value={values[v.key] ?? ''}
                    onChange={(val) =>
                      setValues((prev) => ({ ...prev, [v.key]: val }))
                    }
                    serverError={serverErrors[v.key]}
                    disabled={submitting || state === 'env_qa'}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {required.length === 0 && optional.length === 0 && (
          <p className="text-gray-500 text-sm">
            입력이 필요한 값이 없습니다.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-gray-200 dark:border-gray-800">
          {mode === 'setup' ? (
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={!canSubmit}
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-500 text-white px-5 py-2 rounded-xl text-sm transition-colors"
            >
              {submitting || state === 'env_qa' ? '적용 중...' : '적용하기'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => submit(false)}
                disabled={!canSubmit}
                className="bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 text-gray-700 dark:text-gray-200 px-5 py-2 rounded-xl text-sm transition-colors"
              >
                💾 저장
              </button>
              <button
                type="button"
                onClick={() => submit(true)}
                disabled={!canSubmit}
                className="bg-green-600 hover:bg-green-500 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-500 text-white px-5 py-2 rounded-xl text-sm transition-colors"
              >
                {submitting || state === 'env_qa' ? '재시작 중...' : '💾 저장 후 재시작'}
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function EnvField({
  v,
  value,
  onChange,
  serverError,
  disabled,
}: {
  v: EnvVarView;
  value: string;
  onChange: (v: string) => void;
  serverError?: string;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  const [touched, setTouched] = useState(false);
  const placeholder = v.example ?? '';
  const local = validateLocal(v, value);
  const showError = serverError || (touched && !local.ok);
  const errorHint =
    serverError ?? (!local.ok ? (local as { hint: string }).hint : undefined);

  const valueIsEmpty = value.length === 0;
  const showOk = touched && !valueIsEmpty && local.ok && !serverError;

  return (
    <div>
      <label className="block mb-1">
        <span className="text-sm font-medium text-gray-900 dark:text-white">
          {v.key}
        </span>
        {v.required && <span className="text-red-500 ml-1">*</span>}
        {v.has_value && (
          <span className="text-xs text-gray-500 ml-2">
            기존값: {v.masked_preview}
          </span>
        )}
      </label>
      {v.description && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">{v.description}</p>
      )}
      {v.issuance_guide && (
        <p className="text-xs text-gray-500 mb-2">ⓘ 발급 방법: {v.issuance_guide}</p>
      )}
      <div className="flex gap-2">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          className={`flex-1 bg-white dark:bg-gray-900 border rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none disabled:opacity-50 ${
            showError
              ? 'border-red-500 focus:border-red-500'
              : 'border-gray-300 dark:border-gray-700 focus:border-gray-500'
          }`}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white px-2"
        >
          {show ? '숨기기' : '보기'}
        </button>
      </div>
      {showError && errorHint && (
        <p className="text-xs text-red-500 mt-1">⚠ {errorHint}</p>
      )}
      {showOk && (
        <p className="text-xs text-green-600 dark:text-green-400 mt-1">✓ 형식 OK</p>
      )}
    </div>
  );
}

function FailureBanner({
  verdict,
  showReason,
  onToggleReason,
  onRetry,
  onGoPlanning,
}: {
  verdict: FailureVerdict;
  showReason: boolean;
  onToggleReason: () => void;
  onRetry: () => void;
  onGoPlanning: () => void;
}) {
  const copy = FAILURE_COPY[verdict.kind];
  const bg =
    copy.tone === 'warn'
      ? 'bg-orange-500/10 border-orange-500/30 text-orange-600 dark:text-orange-400'
      : copy.tone === 'info'
        ? 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400'
        : 'bg-red-500/10 border-red-500/30 text-red-600 dark:text-red-400';
  const willBounce =
    verdict.next_state === 'planning' || verdict.next_state === 'planning_update';

  return (
    <div className={`border rounded-xl p-4 mb-6 ${bg}`}>
      <p className="font-medium mb-1">{copy.title}</p>
      <p className="text-sm opacity-90">{verdict.message}</p>

      <div className="flex gap-2 mt-3">
        {!willBounce && verdict.kind === 'transient' && (
          <button
            type="button"
            onClick={onRetry}
            className="text-sm bg-white/60 dark:bg-gray-900 border border-current px-3 py-1.5 rounded-lg hover:opacity-80"
          >
            다시 시도
          </button>
        )}
        {willBounce && (
          <button
            type="button"
            onClick={onGoPlanning}
            className="text-sm bg-white/60 dark:bg-gray-900 border border-current px-3 py-1.5 rounded-lg hover:opacity-80"
          >
            {verdict.next_state === 'planning' ? '기획 대화로' : '수정 요청으로'}
          </button>
        )}
        <button
          type="button"
          onClick={onToggleReason}
          className="text-sm opacity-70 hover:opacity-100 ml-auto"
        >
          {showReason ? '▾ 세부 내용' : '▸ 세부 내용'}
        </button>
      </div>

      {showReason && (
        <div className="mt-3 pt-3 border-t border-current/20 text-xs opacity-80 font-mono whitespace-pre-wrap">
          <div>분류: {verdict.kind}</div>
          {verdict.matched_rule && <div>매칭 규칙: {verdict.matched_rule}</div>}
          <div>다음 상태: {verdict.next_state}</div>
          {verdict.reason_snippet && (
            <div className="mt-2">{verdict.reason_snippet}</div>
          )}
        </div>
      )}
    </div>
  );
}
