import { Component, ErrorInfo, ReactNode, useEffect, useState } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Film, ImageOff, Loader2, Play } from 'lucide-react';
import clsx from 'clsx';
import { serverStatus } from '../lib/api';
import { Role, useAuth } from '../lib/auth';
import { Button, Spinner } from './ui';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold">Something broke on this page</h1>
        <p className="mt-2 text-sm text-muted">Your bookings are safe. Reload to try again.</p>
        <Button className="mt-6" onClick={() => window.location.assign('/')}>Back to home</Button>
      </div>
    );
  }
}

/** Route guard: requires a signed-in user with one of the roles; managers must also be approved unless allowPending. */
export function RequireAuth({ roles, allowPending }: { roles?: Role[]; allowPending?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Checking your session" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/forbidden" replace />;
  if (user.role === 'THEATRE_MANAGER' && user.accountStatus !== 'ACTIVE' && !allowPending) {
    return <Navigate to="/manager/pending" replace />;
  }
  return <Outlet />;
}

/** Shown while the free-tier backend wakes up from idle. */
export function ColdStartBanner() {
  const [waking, setWaking] = useState(false);
  useEffect(() => serverStatus.subscribe(setWaking), []);
  if (!waking) return null;
  return (
    <div role="status" className="sticky top-0 z-[60] flex items-center justify-center gap-2 bg-warn/15 px-4 py-2 text-center text-sm text-warn backdrop-blur">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      Waking up the server — the first request can take up to a minute. Hang tight, nothing is lost.
    </div>
  );
}

export function SafeImage({ src, alt, className, ratio = 'poster' }: { src?: string | null; alt: string; className?: string; ratio?: 'poster' | 'banner' }) {
  const [failed, setFailed] = useState(false);
  const box = ratio === 'poster' ? 'aspect-[2/3]' : 'aspect-[16/7]';
  if (!src || failed) {
    return (
      <div role="img" aria-label={alt} className={clsx(box, 'flex items-center justify-center bg-gradient-to-br from-raised to-surface text-muted', className)}>
        {failed ? <ImageOff className="h-8 w-8" aria-hidden /> : <Film className="h-8 w-8" aria-hidden />}
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} className={clsx(box, 'object-cover', className)} />;
}

/** Embeds a trailer only after the user asks for it, so no third-party requests happen on page load. */
export function TrailerPlayer({ url, title }: { url?: string | null; title: string }) {
  const [playing, setPlaying] = useState(false);
  if (!url) return <p className="text-sm text-muted">No trailer available.</p>;
  if (!playing) {
    return (
      <button onClick={() => setPlaying(true)} className="group flex aspect-video w-full items-center justify-center rounded-2xl border border-line bg-raised transition hover:border-brand/50" aria-label={`Play trailer for ${title}`}>
        <span className="flex items-center gap-2 rounded-full bg-brand px-5 py-3 text-sm font-medium shadow-glow transition group-hover:scale-105"><Play className="h-4 w-4 fill-current" aria-hidden /> Watch trailer</span>
      </button>
    );
  }
  const isEmbed = /^https:\/\/(www\.)?(youtube-nocookie\.com|youtube\.com)\/embed\//.test(url);
  return isEmbed ? (
    <iframe title={`${title} trailer`} src={`${url}?autoplay=1&rel=0`} className="aspect-video w-full rounded-2xl border border-line" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
  ) : (
    <video src={url} controls autoPlay className="aspect-video w-full rounded-2xl border border-line bg-black" />
  );
}

export function Logo({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="flex items-center gap-2 font-display text-lg font-bold">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand shadow-glow"><Play className="h-4 w-4 fill-white text-white" aria-hidden /></span>
      Cine<span className="text-brand">Book</span>
    </Link>
  );
}
