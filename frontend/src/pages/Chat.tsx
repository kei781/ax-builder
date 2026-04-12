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

  // Load conversation history on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const res = await client.get(
          `/projects/${id}/chat/history?type=${chatType}`,
        );
        const data = res.data;
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
      } catch {
        // Silently fail – user can still start a new conversation
      } finally {
        setHistoryLoading(false);
      }
    };
    loadHistory();
  }, [id, chatType]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

  const handleBuild = async () => {
    if (!scorePassed) return;
    try {
      await client.post(`/projects/${id}/build`);
      navigate(`/projects/${id}/build`);
    } catch {
      alert('빌드 시작에 실패했습니다.');
    }
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
    <div className="h-screen bg-gray-950 flex overflow-hidden">
      {/* Chat Area */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Sticky Header + Phase */}
        <div className="shrink-0 sticky top-0 z-10 bg-gray-950">
          <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
            <a href="/" className="text-gray-500 hover:text-white">
              ← 대시보드
            </a>
            <h1 className="text-white font-medium">
              {chatType === 'scoring'
                ? '새 프로젝트 기획'
                : chatType === 'bug_report'
                  ? '버그 리포트'
                  : '서비스 개선'}
            </h1>
          </header>

          {/* Phase Indicator */}
          <div className="px-6 py-3 border-b border-gray-800">
            <div className="flex gap-4">
              {phaseLabels.map((p) => (
                <span
                  key={p.key}
                  className={`text-sm ${
                    phase === p.key
                      ? 'text-green-400 font-medium'
                      : 'text-gray-600'
                  }`}
                >
                  {phase === p.key ? '●' : '○'} {p.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {historyLoading && (
            <div className="flex justify-center items-center mt-20">
              <div className="w-6 h-6 border-2 border-gray-600 border-t-green-400 rounded-full animate-spin" />
              <span className="ml-3 text-gray-500 text-sm">대화 불러오는 중...</span>
            </div>
          )}
          {!historyLoading && messages.length === 0 && (
            <div className="text-center text-gray-600 mt-20">
              <p className="text-lg mb-2">어떤 문제를 해결하고 싶으신가요?</p>
              <p className="text-sm">
                AI가 아이디어를 제품으로 구체화해드립니다.
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <ChatMessage key={i} role={msg.role} content={msg.content} />
          ))}
          {loading && (
            <div className="flex justify-start mb-4">
              <div className="bg-gray-800 rounded-2xl rounded-bl-md px-4 py-3">
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

        {/* Input */}
        <div className="border-t border-gray-800 px-6 py-4">
          <div className="flex gap-3 items-end">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                autoResize();
              }}
              placeholder="아이디어를 입력하세요..."
              className="flex-1 bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:border-green-500 focus:outline-none resize-none leading-5"
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
              className="bg-green-600 hover:bg-green-500 disabled:bg-gray-700 text-white px-6 py-3 rounded-xl text-sm font-medium transition-colors shrink-0"
            >
              전송
            </button>
          </div>
          <p className="text-gray-600 text-xs mt-1">Shift+Enter로 줄바꿈</p>
        </div>
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
          <div className="w-full bg-gray-800 rounded-full h-3 mb-2">
            <div
              className="bg-green-500 h-3 rounded-full transition-all duration-500"
              style={{ width: `${(score / 1000) * 100}%` }}
            />
          </div>
          <p className={`text-sm ${getTierColor()}`}>{scoreTierLabel}</p>
        </div>

        <div className="mb-6">
          <h3 className="text-gray-400 text-xs uppercase mb-3">항목별 점수</h3>
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
          <div className="mb-6">
            <h3 className="text-gray-400 text-xs uppercase mb-2">
              보완 필요 항목
            </h3>
            <ul className="space-y-1">
              {missingItems.map((item, i) => (
                <li key={i} className="text-gray-500 text-xs flex gap-1">
                  <span className="text-yellow-500">•</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-auto">
          <button
            onClick={handleBuild}
            disabled={!scorePassed}
            className={`w-full py-3 rounded-xl text-sm font-medium transition-colors ${
              scorePassed
                ? 'bg-green-600 hover:bg-green-500 text-white'
                : 'bg-gray-800 text-gray-600 cursor-not-allowed'
            }`}
          >
            {scorePassed ? '🚀 제작 시작' : '스코어 900점 이상 시 제작 가능'}
          </button>
        </div>
      </div>
    </div>
  );
}
