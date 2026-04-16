import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import client from '../api/client';

export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // 신청서 폼 상태
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ email: '', name: '', organization: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    const token = searchParams.get('token');
    const error = searchParams.get('error');

    if (token) {
      localStorage.setItem('token', token);
      window.location.href = '/';
    }

    if (error === 'need_application') {
      setShowForm(true);
      setFormData((prev) => ({
        ...prev,
        email: searchParams.get('email') || prev.email,
        name: searchParams.get('name') || prev.name,
      }));
    }
  }, [searchParams]);

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  const error = searchParams.get('error');

  const handleSubmitRequest = async () => {
    if (!formData.email || !formData.name || !formData.organization) {
      setFormError('모든 항목을 입력해주세요.');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await client.post('/auth/access-request', formData);
      setSubmitted(true);
    } catch (err: any) {
      const msg = err.response?.data?.message || '신청 중 오류가 발생했습니다.';
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
      <div className="bg-white dark:bg-gray-900 rounded-2xl p-10 max-w-md w-full mx-4 text-center shadow-lg dark:shadow-none">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">ax-builder</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-8">
          아이디어를 말하면 AI가 제품을 만들어줍니다
        </p>

        {/* 일반 에러 (auth_failed, domain_invalid 등) */}
        {error && error !== 'need_application' && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-3 mb-6 text-sm">
            {error === 'auth_failed'
              ? '로그인에 실패했습니다.'
              : error === 'domain_invalid'
                ? '허용되지 않은 계정입니다.'
                : '알 수 없는 오류가 발생했습니다.'}
          </div>
        )}

        {/* 신청서 폼 */}
        {showForm && !submitted && (
          <div className="text-left mb-6">
            <div className="bg-yellow-500/10 border border-yellow-500/30 text-yellow-600 dark:text-yellow-400 rounded-lg p-3 mb-4 text-sm">
              이 서비스를 이용하려면 사용 신청이 필요합니다.
            </div>

            {formError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg p-3 mb-4 text-sm">
                {formError}
              </div>
            )}

            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">이메일</label>
            <input
              type="email"
              value={formData.email}
              onChange={(e) => setFormData((p) => ({ ...p, email: e.target.value }))}
              className="w-full bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white rounded-xl px-4 py-3 text-sm border border-gray-200 dark:border-gray-700 focus:border-green-500 focus:outline-none mb-3"
              placeholder="you@example.com"
            />

            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">성함</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
              className="w-full bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white rounded-xl px-4 py-3 text-sm border border-gray-200 dark:border-gray-700 focus:border-green-500 focus:outline-none mb-3"
              placeholder="홍길동"
            />

            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">소속</label>
            <input
              type="text"
              value={formData.organization}
              onChange={(e) => setFormData((p) => ({ ...p, organization: e.target.value }))}
              className="w-full bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-white rounded-xl px-4 py-3 text-sm border border-gray-200 dark:border-gray-700 focus:border-green-500 focus:outline-none mb-4"
              placeholder="회사/학교/조직명"
            />

            <button
              onClick={handleSubmitRequest}
              disabled={submitting}
              className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-400 text-white font-medium py-3 px-6 rounded-xl transition-colors"
            >
              {submitting ? '신청 중...' : '사용 신청'}
            </button>

            <button
              onClick={() => { setShowForm(false); }}
              className="w-full mt-2 text-gray-500 text-sm hover:text-gray-700 dark:hover:text-gray-300 py-2"
            >
              뒤로가기
            </button>
          </div>
        )}

        {/* 신청 완료 메시지 */}
        {submitted && (
          <div className="mb-6">
            <div className="bg-green-500/10 border border-green-500/30 text-green-600 dark:text-green-400 rounded-lg p-4 text-sm">
              <p className="font-medium mb-1">신청이 접수되었습니다</p>
              <p>관리자 승인 후 이메일로 안내됩니다. 승인 후 다시 로그인해주세요.</p>
            </div>
            <button
              onClick={() => { setSubmitted(false); setShowForm(false); }}
              className="mt-4 text-gray-500 text-sm hover:text-gray-700 dark:hover:text-gray-300"
            >
              로그인 화면으로
            </button>
          </div>
        )}

        {/* Google 로그인 버튼 (신청서 폼이 아닐 때) */}
        {!showForm && !submitted && (
          <>
            <button
              onClick={login}
              className="w-full bg-white text-gray-900 font-medium py-3 px-6 rounded-xl hover:bg-gray-100 transition-colors flex items-center justify-center gap-3 border border-gray-200 dark:border-transparent"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              Google로 로그인
            </button>

            <p className="text-gray-500 text-sm mt-4">
              Google 계정으로 로그인하세요
            </p>
          </>
        )}
      </div>
    </div>
  );
}
