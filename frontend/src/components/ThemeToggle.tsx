import { useTheme } from '../contexts/ThemeContext';

export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className="text-gray-500 hover:text-gray-900 dark:hover:text-gray-200 text-sm px-2 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      title={theme === 'dark' ? '라이트 모드로' : '다크 모드로'}
    >
      {theme === 'dark' ? '☀️' : '🌙'}
    </button>
  );
}
