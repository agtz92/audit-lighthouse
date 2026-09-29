import type { Metadata } from 'next';
import './globals.css';
import { ThemeToggle } from '@/components/theme-toggle';
import { NavLinks } from '@/components/nav-links';

export const metadata: Metadata = {
  title: 'site-monitor',
  description: 'Auditoría diaria de disponibilidad, rendimiento y archivo en PDF',
};

/**
 * Aplica el tema guardado antes del primer pintado. Sin esto, un usuario con el
 * interruptor en oscuro y el sistema en claro ve un destello blanco en cada carga.
 */
const THEME_BOOTSTRAP = `
try {
  var t = localStorage.getItem('sitemon-theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <div className="shell">
          <div className="topbar">
            <h1>site-monitor</h1>
            <NavLinks />
            <div className="spacer" />
            <ThemeToggle />
          </div>
          {children}
        </div>
      </body>
    </html>
  );
}
