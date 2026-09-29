'use client';

import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';

const LABELS: Record<Theme, string> = { system: 'Sistema', light: 'Claro', dark: 'Oscuro' };
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  // El tema inicial ya lo aplicó el script del layout; aquí solo se sincroniza
  // el estado de React con lo que quedó en el DOM.
  useEffect(() => {
    const stored = localStorage.getItem('sitemon-theme');
    if (stored === 'dark' || stored === 'light') setTheme(stored);
  }, []);

  function apply(next: Theme): void {
    setTheme(next);
    if (next === 'system') {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem('sitemon-theme');
    } else {
      document.documentElement.dataset.theme = next;
      localStorage.setItem('sitemon-theme', next);
    }
  }

  return (
    <button className="ghost" onClick={() => apply(NEXT[theme])} title="Cambiar tema">
      {LABELS[theme]}
    </button>
  );
}
