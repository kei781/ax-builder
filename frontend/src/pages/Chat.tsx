import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import ChatMessage from '../components/ChatMessage';
import ScoreBar from '../components/ScoreBar';
import client from '../api/client';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function Chat() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const chatType = (searchParams.get('type') || 'scoring') as
    | 'scoring'
    | 'bug_report'
    | 'improvement';

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [score, setScore] = useState(0);
  const [breakdown, setBreakdown] = useState({
    problem_definition: 0,
    feature_list: 0,
    user_flow: 0,
    feasibility: 0,
    user_experience: 0,
  });
  const [phase, setPhase] = useState('discovery');
  const [scoreTierLabel, setScoreTierLabel] = useState('대화를 시작하세요');
  const [scorePassed, setScorePassed] = useState(false);
  const [missingItems, setMissingItems] = useState<string[]>([]);
  const [prdContent, setPrdContent] = useState<string | null>(null);
  const [designContent, setDesignContent] = useState<string | null>(null);
  const [prototypeHtml, setPrototypeHtml] = useState<string | null>(null);
  const [showPrd, setShowPrd] = useState(false);
  const [showDesign, setShowDesign] = useState(false);
  const [showPrototype, setShowPrototype] = useState(false);
  const [generatingPrototype, setGeneratingPrototype] = useState(false);
  const [prdGenerating, setPrdGenerating] = useState(false);
  const [prdGenError, setPrdGenError] = useState<string | null>(null);
  const [prdOutdated, setPrdOutdated] = useState(false);
  const [designOutdated, setDesignOutdated] = useState(false);
  const [show900Modal, setShow900Modal] = useState(false);
  const [showOutdatedWarning, setShowOutdatedWarning] = useState(false);
  const [showBuildConfirm, setShowBuildConfirm] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [ownerName, setOwnerName] = useState<string>('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // 내용 없으면 1줄로 리셋
    if (!el.value.trim()) {
      el.style.height = '44px';
      el.style.overflowY = 'hidden';
      return;
    }
    el.style.height = 'auto';
    const lineHeight = 20;
    const maxHeight = lineHeight * 15; // 15줄 최대
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Load conversation history + project info on mount
  useEffect(() => {
    const loadAll = async () => {
      try {
        const [historyRes, projectsRes] = await Promise.all([
          client.get(`/projects/${id}/chat/history?type=${chatType}`),
          client.get('/projects'),
        ]);

        // 내 role 확인 — 내 프로젝트 목록에 있는지 체크
        const myProject = projectsRes.data.find(
          (p: { id: string; myRole: string; ownerName: string }) => p.id === id,
        );
        if (myProject) {
          const role = myProject.myRole;
          setReadOnly(role === 'viewer');
          setOwnerName(myProject.ownerName || '');
        } else {
          // 팀 프로젝트 목록에서 확인
          try {
            const teamRes = await client.get('/projects/team');
            const teamProject = teamRes.data.find(
              (p: { id: string; ownerName: string }) => p.id === id,
            );
            if (teamProject) {
              setReadOnly(true);
              setOwnerName(teamProject.ownerName || '');
            }
          } catch { /* ignore */ }
        }

        const data = historyRes.data;
        if (data.messages && data.messages.length > 0) {
          setMessages(
            data.messages.map((m: { role: string; content: string }) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            })),
          );
          setScore(data.score);
          setBreakdown(data.breakdown);
          setPhase(data.current_phase);
          setScoreTierLabel(data.score_label);
          setScorePassed(data.score_passed);
          setMissingItems(data.missing_items || []);
        }
        if (data.prd_content) setPrdContent(data.prd_content);
        if (data.design_content) setDesignContent(data.design_content);
        if (data.prd_generating) setPrdGenerating(true);
        if (data.prd_gen_error) setPrdGenError(data.prd_gen_error);
        setPrdOutdated(!!data.prd_outdated);
        setDesignOutdated(!!data.design_outdated);
        // 프로토타입 존재 여부 확인
        client.get(`/projects/${id}/prototype`, { responseType: 'text' })
          .then((r) => { if (r.data) setPrototypeHtml(r.data as string); })
          .catch(() => {});
      } catch {
        // Silently fail
      } finally {
        setHistoryLoading(false);
      }
    };
    loadAll();
  }, [id, chatType]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // PRD/DESIGN 백그라운드 생성 중이면 5초마다 폴링
  useEffect(() => {
    if (!prdGenerating || !id) return;
    const timer = setInterval(async () => {
      try {
        const res = await client.get(`/projects/${id}/chat/history?type=${chatType}`);
        const data = res.data;
        // 새 내용이 들어왔는지 감지 (길이 변화로 판단)
        if (data.prd_content) setPrdContent(data.prd_content);
        if (data.design_content) setDesignContent(data.design_content);
        setPrdOutdated(!!data.prd_outdated);
        setDesignOutdated(!!data.design_outdated);
        if (data.prd_gen_error) setPrdGenError(data.prd_gen_error);
        if (!data.prd_generating) {
          setPrdGenerating(false);
          // 에러 없이 끝났는데 prd/design이 여전히 비어있으면 사용자에게 알림
          if (!data.prd_gen_error && !data.prd_content && !data.design_content) {
            setPrdGenError('PRD/DESIGN이 생성되지 않았습니다. 백엔드 로그를 확인해주세요.');
          }
        }
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(timer);
  }, [prdGenerating, id, chatType]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;

    const userMsg: Message = { role: 'user', content: input };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setLoading(true);
    // textarea 높이 리셋
    if (textareaRef.current) {
      textareaRef.current.style.height = '44px';
      textareaRef.current.style.overflowY = 'hidden';
    }

    try {
      const res = await client.post(`/projects/${id}/chat`, {
        message: input,
        type: chatType,
      });

      const data = res.data;
      const aiMsg: Message = { role: 'assistant', content: data.reply };
      setMessages((prev) => [...prev, aiMsg]);

      setScore(data.score);
      setBreakdown(data.breakdown);
      setPhase(data.current_phase);
      setScoreTierLabel(data.score_label);
      setScorePassed(data.score_passed);
      setMissingItems(data.missing_items || []);
      if (data.prd_generating) setPrdGenerating(true);
      setPrdOutdated(!!data.prd_outdated);
      setDesignOutdated(!!data.design_outdated);
      // 900점 처음 도달 시 안내 모달
      if (data.crossed_900) setShow900Modal(true);
      // 초안 존재 + 구버전 상태라면 경고 모달 (900 도달 모달과 겹치지 않게)
      else if ((data.prd_outdated || data.design_outdated) && (prdContent || designContent)) {
        setShowOutdatedWarning(true);
      }
    } catch (err) {
      const aiMsg: Message = {
        role: 'assistant',
        content: '오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
      };
      setMessages((prev) => [...prev, aiMsg]);
    } finally {
      setLoading(false);
    }
  };

  const handleRegeneratePrd = async () => {
    if (prdGenerating) return;
    setPrdGenError(null);
    try {
      const res = await client.post(`/projects/${id}/regenerate-prd`);
      if (res.data.started) {
        setPrdGenerating(true);
        setShow900Modal(false);
      } else {
        alert(res.data.message || 'PRD 재생성을 시작할 수 없습니다.');
      }
    } catch {
      alert('PRD 재생성 요청에 실패했습니다.');
    }
  };

  const handleGeneratePrototype = async () => {
    if (generatingPrototype) return;
    setGeneratingPrototype(true);
    try {
      const res = await client.post(`/projects/${id}/prototype`);
      setPrototypeHtml(res.data.html);
      setShowPrototype(true);
    } catch {
      alert('프로토타입 생성에 실패했습니다.');
    } finally {
      setGeneratingPrototype(false);
    }
  };

  const doBuild = async () => {
    try {
      await client.post(`/projects/${id}/build`);
      navigate(`/projects/${id}/build`);
    } catch {
      alert('빌드 시작에 실패했습니다.');
    }
  };

  const handleBuild = () => {
    if (!scorePassed) return;
    // 구버전이면 확인 모달 먼저
    if (prdOutdated || designOutdated) {
      setShowBuildConfirm(true);
      return;
    }
    doBuild();
  };

  const phaseLabels = [
    { key: 'discovery', label: '문제발견' },
    { key: 'structuring', label: '기능구조화' },
    { key: 'validation', label: '검증' },
  ];

  const getTierColor = () => {
    if (score >= 900) return 'text-green-400';
    if (score >= 700) return 'text-yellow-400';
    if (score >= 500) return 'text-orange-400';
    return 'text-red-400';
  };

  return (
    <div className="h-screen bg-gray-50 dark:bg-gray-950 flex overflow-hidden">
      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Sticky Header + Phase */}
        <div className="shrink-0 sticky top-0 z-10 bg-gray-50 dark:bg-gray-950">
          <header className="border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center gap-4">
            <a href="/" className="text-gray-500 hover:text-gray-900 dark:hover:text-white">
              ← 대시보드
            </a>
            <h1 className="text-gray-900 dark:text-white font-medium">
              {chatType === 'scoring'
                ? '새 프로젝트 기획'
                : chatType === 'bug_report'
                  ? '버그 리포트'
                  : '서비스 개선'}
            </h1>
          </header>

          {/* Phase Indicator */}
          <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-800">
            <div className="flex gap-4">
              {phaseLabels.map((p) => (
                <span
                  key={p.key}
                  className={`text-sm ${
                    phase === p.key
                      ? 'text-green-600 dark:text-green-400 font-medium'
                      : 'text-gray-400 dark:text-gray-600'
                  }`}
                >
                  {phase === p.key ? '●' : '○'} {p.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-6 py-4">
          {historyLoading && (
            <div className="flex justify-center items-center mt-20">
              <div className="w-6 h-6 border-2 border-gray-600 border-t-green-400 rounded-full animate-spin" />
              <span className="ml-3 text-gray-500 text-sm">대화 불러오는 중...</span>
            </div>
          )}
          {!historyLoading && messages.length === 0 && (
            <div className="text-center text-gray-500 dark:text-gray-600 mt-20">
              <p className="text-lg mb-2 text-gray-900 dark:text-white">어떤 문제를 해결하고 싶으신가요?</p>
              <p className="text-sm">
                AI가 아이디어를 제품으로 구체화해드립니다.
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <ChatMessage
              key={i}
              role={msg.role}
              content={msg.content}
              userLabel={readOnly ? ownerName || 'owner' : 'owner'}
            />
          ))}
          {loading && (
            <div className="flex justify-start mb-4">
              <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
                <div className="flex gap-1">
                  <div className="w-2 h-2 bg-gray-500 rounded-full animate-bounce" />
                  <div
                    className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: '0.1s' }}
                  />
                  <div
                    className="w-2 h-2 bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: '0.2s' }}
                  />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input (owner/editor만) */}
        {readOnly ? (
          <div className="border-t border-gray-200 dark:border-gray-800 px-6 py-4 bg-gray-100 dark:bg-gray-900/50">
            <p className="text-center text-sm text-gray-500">
              🔒 읽기 전용 — {ownerName}님이 만든 프로젝트입니다. 대화 내역만 확인할 수 있습니다.
            </p>
          </div>
        ) : (
          <div className="border-t border-gray-200 dark:border-gray-800 px-6 py-4">
            <div className="flex gap-3 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  autoResize();
                }}
                placeholder="아이디어를 입력하세요..."
                className="flex-1 bg-white dark:bg-gray-900 text-gray-900 dark:text-white rounded-xl px-4 py-3 text-sm border border-gray-200 dark:border-gray-700 focus:border-green-500 focus:outline-none resize-none leading-5"
                style={{ height: '44px', overflowY: 'hidden' }}
                rows={1}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={loading}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="bg-green-600 hover:bg-green-500 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white px-6 py-3 rounded-xl text-sm font-medium transition-colors shrink-0"
              >
                전송
              </button>
            </div>
            <p className="text-gray-500 dark:text-gray-600 text-xs mt-1">Shift+Enter로 줄바꿈</p>
          </div>
        )}
      </div>

      {/* Score Sidebar — sticky, scrolls internally */}
      <div className="w-80 border-l border-gray-800 p-6 flex flex-col overflow-y-auto shrink-0">
        <div className="mb-6">
          <div className="flex items-baseline justify-between mb-2">
            <span className="text-gray-400 text-sm">스코어</span>
            <span className={`text-2xl font-bold ${getTierColor()}`}>
              {score}
              <span className="text-gray-600 text-sm font-normal">/1000</span>
            </span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-800 rounded-full h-3 mb-2">
            <div
              className="bg-green-500 h-3 rounded-full transition-all duration-500"
              style={{ width: `${(score / 1000) * 100}%` }}
            />
          </div>
          <p className={`text-sm ${getTierColor()}`}>{scoreTierLabel}</p>
        </div>

        <div className="mb-6">
          <h3 className="text-gray-500 dark:text-gray-400 text-xs uppercase mb-3">항목별 점수</h3>
          <ScoreBar
            label="문제 정의"
            score={breakdown.problem_definition}
            maxScore={200}
          />
          <ScoreBar
            label="기능 목록"
            score={breakdown.feature_list}
            maxScore={200}
          />
          <ScoreBar
            label="사용 흐름"
            score={breakdown.user_flow}
            maxScore={200}
          />
          <ScoreBar
            label="기술 실현성"
            score={breakdown.feasibility}
            maxScore={200}
          />
          <ScoreBar
            label="사용자 경험"
            score={breakdown.user_experience}
            maxScore={200}
          />
        </div>

        {/* Missing Items */}
        {missingItems.length > 0 && (
          <div className="mb-6 bg-yellow-50 dark:bg-yellow-400/10 border border-yellow-300 dark:border-yellow-500/40 rounded-xl p-4">
            <h3 className="text-yellow-700 dark:text-yellow-300 text-xs font-bold uppercase tracking-wider mb-3 flex items-center gap-2">
              <span className="text-base">⚠️</span>
              보완 필요 항목
            </h3>
            <ul className="space-y-2">
              {missingItems.map((item, i) => (
                <li
                  key={i}
                  className="text-gray-900 dark:text-white text-sm flex gap-2 leading-snug"
                >
                  <span className="text-yellow-600 dark:text-yellow-400 font-bold shrink-0">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* PRD 생성 에러 배너 */}
        {prdGenError && (
          <div className="mb-3 p-3 rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 text-xs leading-relaxed">
            <div className="font-semibold mb-1">⚠️ PRD/DESIGN 생성 실패</div>
            <div className="opacity-80 break-words">{prdGenError}</div>
            <button
              onClick={() => setPrdGenError(null)}
              className="mt-2 text-[10px] text-red-300 hover:text-red-200 underline"
            >
              닫기
            </button>
          </div>
        )}

        {/* Document & Prototype buttons */}
        <div className="mb-4 flex flex-col gap-2">
          {/* PRD 초안 보기 — 존재 + !outdated 일 때만 활성 */}
          <button
            onClick={() => setShowPrd(true)}
            disabled={!prdContent || prdOutdated || prdGenerating}
            className="w-full py-2.5 rounded-xl text-sm font-medium border border-blue-400/50 text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {prdGenerating && <span className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />}
            📄 PRD 초안 보기
            {prdGenerating && ' (생성 중...)'}
            {!prdGenerating && prdContent && prdOutdated && ' (구버전)'}
          </button>
          {/* DESIGN 초안 보기 */}
          <button
            onClick={() => setShowDesign(true)}
            disabled={!designContent || designOutdated || prdGenerating}
            className="w-full py-2.5 rounded-xl text-sm font-medium border border-purple-400/50 text-purple-400 hover:bg-purple-400/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {prdGenerating && <span className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />}
            🎨 DESIGN 초안 보기
            {prdGenerating && ' (생성 중...)'}
            {!prdGenerating && designContent && designOutdated && ' (구버전)'}
          </button>
          {/* PRD/DESIGN 재생성 — 900+ 일 때만 활성 */}
          <button
            onClick={handleRegeneratePrd}
            disabled={!scorePassed || prdGenerating}
            className="w-full py-2.5 rounded-xl text-sm font-medium bg-green-500/10 border border-green-500/40 text-green-400 hover:bg-green-500/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title={!scorePassed ? '스코어 900점 이상에서만 사용 가능' : '대화 기반으로 PRD/DESIGN 재생성'}
          >
            {prdGenerating ? '🔄 생성 중...' : '🔄 PRD/DESIGN 재생성'}
          </button>
          {/* 프로토타입 보기 */}
          <button
            onClick={() => prototypeHtml ? setShowPrototype(true) : undefined}
            disabled={!prototypeHtml}
            className="w-full py-2.5 rounded-xl text-sm font-medium border border-orange-400/50 text-orange-400 hover:bg-orange-400/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            👁 프로토타입 보기
          </button>
          {/* 프로토타입 생성 */}
          <button
            onClick={handleGeneratePrototype}
            disabled={generatingPrototype || !prdContent || prdOutdated}
            className="w-full py-2.5 rounded-xl text-sm font-medium bg-orange-500/10 border border-orange-500/30 text-orange-300 hover:bg-orange-500/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {generatingPrototype ? '생성 중...' : '⚡ 프로토타입 생성'}
          </button>
        </div>

        {!readOnly && (
          <div className="mt-auto">
            <button
              onClick={handleBuild}
              disabled={!scorePassed}
              className={`w-full py-3 rounded-xl text-sm font-medium transition-colors ${
                scorePassed
                  ? 'bg-green-600 hover:bg-green-500 text-white'
                  : 'bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed'
              }`}
            >
              {scorePassed ? '🚀 제작 시작' : '스코어 900점 이상 시 제작 가능'}
            </button>
          </div>
        )}
      </div>

      {/* PRD Modal */}
      {showPrd && prdContent && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
              <h2 className="text-gray-900 dark:text-white font-medium">📄 PRD 초안</h2>
              <button onClick={() => setShowPrd(false)} className="text-gray-400 hover:text-gray-900 dark:hover:text-white text-xl leading-none">✕</button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              <pre className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap font-sans leading-relaxed">{prdContent}</pre>
            </div>
          </div>
        </div>
      )}

      {/* DESIGN Modal */}
      {showDesign && designContent && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800">
              <h2 className="text-gray-900 dark:text-white font-medium">🎨 DESIGN 초안</h2>
              <button onClick={() => setShowDesign(false)} className="text-gray-400 hover:text-gray-900 dark:hover:text-white text-xl leading-none">✕</button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              <pre className="text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap font-sans leading-relaxed">{designContent}</pre>
            </div>
          </div>
        </div>
      )}

      {/* 900점 도달 안내 모달 */}
      {show900Modal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-gray-900 dark:text-white text-lg font-semibold mb-3">🎉 900점 달성!</h2>
            <p className="text-gray-700 dark:text-gray-300 text-sm leading-relaxed mb-5">
              제작 가능 조건을 충족했습니다.<br />
              <strong>PRD/DESIGN 재생성 버튼</strong>을 눌러 최종 문서를 생성한 뒤 제작을 시작하세요.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShow900Modal(false)}
                className="text-gray-500 hover:text-gray-900 dark:hover:text-white px-4 py-2 text-sm"
              >
                나중에
              </button>
              <button
                onClick={handleRegeneratePrd}
                className="bg-green-600 hover:bg-green-500 text-white px-4 py-2 rounded-xl text-sm font-medium"
              >
                지금 생성
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 구버전 경고 모달 (새 채팅 후 기존 PRD/DESIGN이 오래됨) */}
      {showOutdatedWarning && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-yellow-600 dark:text-yellow-400 text-lg font-semibold mb-3">⚠️ 경고</h2>
            <p className="text-gray-700 dark:text-gray-300 text-sm leading-relaxed mb-5 whitespace-pre-line">
              {`구버전 PRD/DESIGN 입니다.\n제작 시작 전 반드시 재생성을 눌러주세요.`}
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => setShowOutdatedWarning(false)}
                className="bg-yellow-500 hover:bg-yellow-400 text-white px-4 py-2 rounded-xl text-sm font-medium"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 제작 시작 구버전 확인 모달 (취소가 CTA) */}
      {showBuildConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h2 className="text-red-600 dark:text-red-400 text-lg font-semibold mb-3">⚠️ 구버전으로 제작 시작</h2>
            <p className="text-gray-700 dark:text-gray-300 text-sm leading-relaxed mb-5 whitespace-pre-line">
              {`구버전 ${prdOutdated && designOutdated ? 'PRD와 DESIGN' : prdOutdated ? 'PRD' : 'DESIGN'} 입니다.\n정말로 구버전을 기준으로 제작을 시작하시겠습니까?\n퀄리티를 보장하지 않습니다.`}
            </p>
            <div className="flex gap-3 justify-end items-center">
              <button
                onClick={() => {
                  setShowBuildConfirm(false);
                  doBuild();
                }}
                className="text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-400 text-xs underline"
              >
                그래도 진행
              </button>
              <button
                onClick={() => setShowBuildConfirm(false)}
                className="bg-green-600 hover:bg-green-500 text-white px-5 py-2.5 rounded-xl text-sm font-semibold shadow-md"
                autoFocus
              >
                취소 (권장)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prototype Modal */}
      {showPrototype && prototypeHtml && (
        <div className="fixed inset-0 bg-black/80 flex flex-col z-50">
          <div className="flex items-center justify-between px-6 py-3 bg-gray-900 border-b border-gray-700">
            <h2 className="text-white font-medium">👁 프로토타입 미리보기</h2>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  const blob = new Blob([prototypeHtml], { type: 'text/html' });
                  const url = URL.createObjectURL(blob);
                  window.open(url, '_blank');
                }}
                className="text-gray-400 hover:text-white text-sm"
              >
                새 탭에서 열기 ↗
              </button>
              <button onClick={() => setShowPrototype(false)} className="text-gray-400 hover:text-white text-xl leading-none">✕</button>
            </div>
          </div>
          <iframe
            srcDoc={prototypeHtml}
            className="flex-1 w-full bg-white"
            sandbox="allow-scripts allow-same-origin"
            title="Prototype"
          />
        </div>
      )}
    </div>
  );
}
