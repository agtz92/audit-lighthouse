'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Panorama' },
  { href: '/runs', label: 'Corridas' },
  { href: '/config', label: 'Sitios' },
];

export function NavLinks() {
  const path = usePathname();
  return (
    <nav>
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path === l.href ? 'active' : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
