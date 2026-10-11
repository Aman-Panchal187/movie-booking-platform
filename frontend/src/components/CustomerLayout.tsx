import { LogOut, Menu, Ticket, X } from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { homeFor, useAuth } from '../lib/auth';
import { Logo } from './common';
import { Button } from './ui';

export function CustomerLayout() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const link = ({ isActive }: { isActive: boolean }) => `rounded-lg px-3 py-2 text-sm transition ${isActive ? 'text-ink' : 'text-muted hover:text-ink'}`;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            <NavLink to="/" end className={link}>Home</NavLink>
            <NavLink to="/movies" className={link}>Movies</NavLink>
            {user?.role === 'CUSTOMER' && <NavLink to="/bookings" className={link}>My bookings</NavLink>}
          </nav>
          <div className="hidden items-center gap-2 md:flex">
            {user ? (
              <>
                {user.role !== 'CUSTOMER' && <Button variant="secondary" size="sm" onClick={() => navigate(homeFor(user))}>Dashboard</Button>}
                <span className="px-2 text-sm text-muted">{user.name.split(' ')[0]}</span>
                <Button variant="ghost" size="sm" onClick={() => { logout(); navigate('/'); }} aria-label="Sign out"><LogOut className="h-4 w-4" /></Button>
              </>
            ) : (
              <>
                <Link to="/login" className="px-3 py-2 text-sm text-muted hover:text-ink">Sign in</Link>
                <Button size="sm" onClick={() => navigate('/register')}>Get started</Button>
              </>
            )}
          </div>
          <button className="rounded-lg p-2 text-muted md:hidden" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <X /> : <Menu />}
          </button>
        </div>
        {open && (
          <div className="border-t border-line px-4 py-3 md:hidden" onClick={() => setOpen(false)}>
            <nav className="flex flex-col gap-1" aria-label="Mobile">
              <NavLink to="/" end className={link}>Home</NavLink>
              <NavLink to="/movies" className={link}>Movies</NavLink>
              {user?.role === 'CUSTOMER' && <NavLink to="/bookings" className={link}>My bookings</NavLink>}
              {user && user.role !== 'CUSTOMER' && <NavLink to={homeFor(user)} className={link}>Dashboard</NavLink>}
              {user ? <button className="rounded-lg px-3 py-2 text-left text-sm text-muted" onClick={() => { logout(); navigate('/'); }}>Sign out</button>
                : <><NavLink to="/login" className={link}>Sign in</NavLink><NavLink to="/register" className={link}>Create account</NavLink></>}
            </nav>
          </div>
        )}
      </header>
      <main className="flex-1"><Outlet /></main>
      <footer className="border-t border-line py-8 text-center text-xs text-muted">
        <p className="flex items-center justify-center gap-1.5"><Ticket className="h-3.5 w-3.5" aria-hidden /> CineBook demo — payments are simulated, no real money moves.</p>
      </footer>
    </div>
  );
}
