'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';

// ── Icons ─────────────────────────────────────────────────────────────────────

function IcEdpresso() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 8h1a4 4 0 1 1 0 8h-1"/>
      <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/>
      <line x1="6" y1="2" x2="6" y2="4"/>
      <line x1="10" y1="2" x2="10" y2="4"/>
      <line x1="14" y1="2" x2="14" y2="4"/>
    </svg>
  );
}

function IcGraph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3"/>
      <circle cx="6" cy="12" r="3"/>
      <circle cx="18" cy="19" r="3"/>
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
    </svg>
  );
}

function IcPrompts() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

function IcMenu() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6"/>
      <line x1="3" y1="12" x2="21" y2="12"/>
      <line x1="3" y1="18" x2="21" y2="18"/>
    </svg>
  );
}

function IcClose() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}

// ── Nav config ────────────────────────────────────────────────────────────────

const MAIN_NAV = [
  {
    href: '/edpresso',
    label: 'Edpresso Shots',
    icon: <IcEdpresso />,
    match: (p: string) => p === '/edpresso' || p.startsWith('/edpresso/'),
  },
];

const ADMIN_NAV = [
  { href: '/graph',    label: 'Pipeline Graph', icon: <IcGraph />    },
  { href: '/prompts',  label: 'Prompts',         icon: <IcPrompts />  },
];

// ── Logo ──────────────────────────────────────────────────────────────────────

function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <Link href="/" onClick={onClick} className="flex items-center gap-2.5 group">
      <span className="h-7 w-7 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0 transition-opacity group-hover:opacity-90"
        style={{ background: 'var(--accent)' }}>
        E
      </span>
      <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Edpresso Shots</span>
    </Link>
  );
}

// ── Sidebar content (shared between desktop fixed + mobile drawer) ─────────────

function SidebarContent({ onNav }: { onNav?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: 'var(--panel)' }}>
      {/* Logo row */}
      <div className="h-14 flex items-center px-4 shrink-0" style={{ borderBottom: '1px solid var(--border-soft)' }}>
        <Logo onClick={onNav} />
      </div>

      {/* Nav area */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {MAIN_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNav}
            className={`nav-link${item.match(pathname || '') ? ' active' : ''}`}
          >
            <span className="shrink-0">{item.icon}</span>
            {item.label}
          </Link>
        ))}

        <div className="pt-5">
          <span className="section-label">Admin</span>
          <div className="mt-1 space-y-0.5">
            {ADMIN_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNav}
                className={`nav-link${pathname === item.href ? ' active' : ''}`}
              >
                <span className="shrink-0">{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      </nav>

      {/* Bottom: theme toggle */}
      <div className="shrink-0 px-2 py-3" style={{ borderTop: '1px solid var(--border-soft)' }}>
        <div className="flex items-center gap-2 px-1 py-1">
          <ThemeToggle />
          <span className="text-xs" style={{ color: 'var(--text-faint)' }}>Theme</span>
        </div>
      </div>
    </div>
  );
}

// ── AppShell ──────────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();

  // Close mobile drawer on navigation
  useEffect(() => { setDrawerOpen(false); }, [pathname]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (drawerOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [drawerOpen]);

  return (
    <>
      {/* ── Desktop: fixed sidebar ── */}
      <aside
        className="hidden lg:flex flex-col fixed inset-y-0 left-0 z-30 w-56"
        style={{ borderRight: '1px solid var(--border-soft)' }}
      >
        <SidebarContent />
      </aside>

      {/* ── Mobile: sticky top bar ── */}
      <header
        className="lg:hidden sticky top-0 z-30 flex items-center justify-between px-4"
        style={{
          height: '52px',
          background: 'var(--panel)',
          borderBottom: '1px solid var(--border-soft)',
        }}
      >
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="h-8 w-8 flex items-center justify-center rounded-lg transition"
          style={{ color: 'var(--text-dim)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--panel-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ''; (e.currentTarget as HTMLElement).style.color = 'var(--text-dim)'; }}
        >
          <IcMenu />
        </button>
        <Logo />
        <ThemeToggle />
      </header>

      {/* ── Mobile: slide-in drawer ── */}
      {drawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="absolute inset-0"
            style={{ background: 'rgba(0,0,0,0.55)' }}
            onClick={() => setDrawerOpen(false)}
          />
          {/* Drawer */}
          <aside className="relative z-10 flex flex-col w-64 h-full" style={{ borderRight: '1px solid var(--border)' }}>
            <div className="flex items-center justify-end px-3 pt-3 shrink-0" style={{ background: 'var(--panel)' }}>
              <button
                onClick={() => setDrawerOpen(false)}
                className="h-7 w-7 flex items-center justify-center rounded-md transition"
                style={{ color: 'var(--text-faint)' }}
              >
                <IcClose />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <SidebarContent onNav={() => setDrawerOpen(false)} />
            </div>
          </aside>
        </div>
      )}

      {/* ── Main content area ── */}
      <div className="lg:pl-56">
        <main className="min-h-screen">
          <div className="max-w-6xl mx-auto px-6 py-8">
            {children}
          </div>
        </main>
      </div>
    </>
  );
}
