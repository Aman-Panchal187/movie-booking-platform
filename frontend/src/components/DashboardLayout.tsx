import clsx from 'clsx';
import { ChevronsLeft, ChevronsRight, LogOut, Menu } from 'lucide-react';
import { ComponentType, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Logo } from './common';
import { Badge } from './ui';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

export function DashboardLayout({ items, area }: { items: NavItem[]; area: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const nav = (
    <nav aria-label={`${area} navigation`} className="flex flex-col gap-1 px-3">
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} onClick={() => setMobile(false)} title={collapsed ? label : undefined}
          className={({ isActive }) => clsx('flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition', isActive ? 'bg-brand-soft text-ink ring-1 ring-brand/30' : 'text-muted hover:bg-raised hover:text-ink', collapsed && 'justify-center')}>
          <Icon className="h-[18px] w-[18px] shrink-0" />
          {!collapsed && <span>{label}</span>}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className={clsx('sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-surface transition-[width] md:flex', collapsed ? 'w-[72px]' : 'w-64')}>
        <div className={clsx('flex h-16 items-center border-b border-line px-4', collapsed && 'justify-center px-0')}>{collapsed ? <Logo to="/" /> : <Logo />}</div>
        <div className="flex-1 overflow-y-auto py-4">{nav}</div>
        <button onClick={() => setCollapsed(!collapsed)} className="m-3 flex items-center justify-center rounded-xl p-2 text-muted hover:bg-raised hover:text-ink" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /><span className="ml-2 text-xs">Collapse</span></>}
        </button>
      </aside>

      {mobile && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setMobile(false)}>
          <div className="absolute inset-0 bg-black/70" />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-line bg-surface py-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 px-4"><Logo /></div>{nav}
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line bg-bg/80 px-4 backdrop-blur-xl sm:px-6">
          <div className="flex items-center gap-3">
            <button className="rounded-lg p-2 text-muted md:hidden" aria-label="Open menu" onClick={() => setMobile(true)}><Menu /></button>
            <Badge tone="info">{area}</Badge>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">{user?.name}</span>
            <button className="rounded-lg p-2 text-muted hover:bg-raised hover:text-ink" aria-label="Sign out" onClick={() => { logout(); navigate('/'); }}><LogOut className="h-4 w-4" /></button>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6"><Outlet /></main>
      </div>
    </div>
  );
}
