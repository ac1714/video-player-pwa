import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../lib/theme';

export const ThemeToggle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <button
      id="header-theme-toggle"
      type="button"
      onClick={toggleTheme}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition cursor-pointer select-none ${
        isDark
          ? 'bg-neutral-900 hover:bg-neutral-850 border-neutral-800 text-neutral-200 hover:text-white'
          : 'bg-white hover:bg-neutral-100 border-neutral-300 text-neutral-800 hover:text-neutral-950 shadow-xs'
      } ${className}`}
      title={`Switch to ${isDark ? 'Light' : 'Dark'} mode`}
      aria-label="Toggle theme"
    >
      {isDark ? (
        <>
          <Sun className="w-3.5 h-3.5 text-amber-400" />
          <span className="hidden sm:inline">Light</span>
        </>
      ) : (
        <>
          <Moon className="w-3.5 h-3.5 text-neutral-700" />
          <span className="hidden sm:inline">Dark</span>
        </>
      )}
    </button>
  );
};
