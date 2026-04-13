interface ChatMessageProps {
  role: 'user' | 'assistant';
  content: string;
  userLabel?: string; // user 메시지 위에 표시할 이름 (예: 'owner' 또는 '노상운')
}

export default function ChatMessage({ role, content, userLabel }: ChatMessageProps) {
  const isUser = role === 'user';

  return (
    <div
      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-4`}
    >
      {/* 상단 라벨 */}
      {isUser && userLabel && (
        <span className="text-xs font-semibold text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 rounded-full mb-1 mr-1">
          {userLabel}
        </span>
      )}

      <div
        className={`max-w-[70%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-blue-600 text-white rounded-br-md'
            : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-bl-md'
        }`}
      >
        {!isUser && (
          <span className="text-xs text-gray-500 dark:text-gray-500 block mb-1">AI</span>
        )}
        <p className="text-sm whitespace-pre-wrap break-words">{content}</p>
      </div>
    </div>
  );
}
