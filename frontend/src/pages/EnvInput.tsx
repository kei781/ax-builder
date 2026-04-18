import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import client from '../api/client';

/**
 * DESIGN.md §4 — env input for `awaiting_env` state.
 *
 * Loads /env/guide, renders required + optional sections, posts to PUT /env.
 * After submit, server goes env_qa → polls health → deployed or back.
 * Polling project state until it leaves awaiting_env/env_qa.
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

  useEffect(() => {
    if (!id) return;
    (async () => {
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
    })();
  }, [id]);

  // Poll state after submit so we know when to leave this page.
  useEffect(() => {
    if (state !== 'env_qa') return;
    const iv = setInterval(async () => {
      if (!id) return;
      try {
        const r = await client.get(`/projects/${id}`);
        setState(r.data.state);
        if (r.data.state === 'deployed') {
          clearInterval(iv);
          setTimeout(() => navigate(`/`), 800);
        } else if (r.data.state === 'awaiting_env') {
          clearInterval(iv);
          // env_qa failed, we're back at awaiting — refresh guide (masked preview)
          const g = await client.get(`/projects/${id}/env/guide`);
          setVars(g.data.vars);
          setSubmitting(false);
          setError('입력하신 값으로 기동에 실패했어요. 값을 다시 확인해주세요.');
        }
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => clearInterval(iv);
  }, [state, id, navigate]);

  const required = vars.filter((v) => v.tier === 'user-required');
  const optional = vars.filter((v) => v.tier === 'user-optional');

  const missingRequired = required.filter(
    (v) => v.required && !v.has_value && !values[v.key]?.trim(),
  );
  const canSubmit = missingRequired.length === 0 && !submitting;

  const onSubmit = async () => {
    if (!id) return;
    setSubmitting(true);
    setError(null);
    const payload = Object.entries(values)
      .filter(([, v]) => v != null && v !== '')
      .map(([key, value]) => ({ key, value }));
    try {
      await client.put(`/projects/${id}/env`, { vars: payload });
      setState('env_qa'); // triggers polling
    } catch (e: any) {
      setSubmitting(false);
      setError(e?.response?.data?.message ?? '저장 실패');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <p className="text-gray-500">불러오는 중...</p>
      </div>
    );
  }

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
      </header>

      <main className="max-w-2xl mx-auto px-6 py-10">
        <p className="text-gray-700 dark:text-gray-300 mb-8">
          이 앱을 실행하려면 아래 값이 필요해요.
        </p>

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6 text-sm text-red-500">
            {error}
          </div>
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
                    disabled={submitting || state === 'env_qa'}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {required.length === 0 && optional.length === 0 && (
          <p className="text-gray-500 text-sm">
            입력이 필요한 값이 없습니다. 잠시 기다려주세요.
          </p>
        )}

        <div className="flex justify-end pt-4 border-t border-gray-200 dark:border-gray-800">
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="bg-green-600 hover:bg-green-500 disabled:bg-gray-200 dark:disabled:bg-gray-800 disabled:text-gray-500 text-white px-5 py-2 rounded-xl text-sm transition-colors"
          >
            {submitting || state === 'env_qa' ? '적용 중...' : '적용하기'}
          </button>
        </div>
      </main>
    </div>
  );
}

function EnvField({
  v,
  value,
  onChange,
  disabled,
}: {
  v: EnvVarView;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  const placeholder = v.example ?? '';
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
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          className="flex-1 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:border-gray-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white px-2"
        >
          {show ? '숨기기' : '보기'}
        </button>
      </div>
    </div>
  );
}
