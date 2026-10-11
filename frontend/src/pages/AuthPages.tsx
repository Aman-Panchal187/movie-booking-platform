import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Clock, ShieldX, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { Logo } from '../components/common';
import { Button, Input, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { homeFor, useAuth } from '../lib/auth';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(255,77,94,0.12),transparent_60%)] px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center"><Logo /></div>
        <div className="card p-6 shadow-2xl sm:p-8">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mb-6 mt-1 text-sm text-muted">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

const loginSchema = z.object({ email: z.string().trim().email('Enter a valid email'), password: z.string().min(1, 'Enter your password') });

export function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  const form = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });

  if (user) return <Navigate to={from ?? homeFor(user)} replace />;
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to book tickets or manage your theatres.">
      <form noValidate className="space-y-4" onSubmit={form.handleSubmit(async (v) => {
        try {
          const u = await login(v.email, v.password);
          navigate(from && u.role === 'CUSTOMER' ? from : homeFor(u), { replace: true });
        } catch (err) { toast.error(errorMessage(err)); }
      })}>
        <Input id="email" type="email" label="Email" autoComplete="email" error={form.formState.errors.email?.message} {...form.register('email')} />
        <Input id="password" type="password" label="Password" autoComplete="current-password" error={form.formState.errors.password?.message} {...form.register('password')} />
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>Sign in</Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">New here? <Link to="/register" className="text-brand hover:underline">Create an account</Link></p>
    </AuthShell>
  );
}

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name'),
  email: z.string().trim().email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters').regex(/[A-Za-z]/, 'Include a letter').regex(/\d/, 'Include a number'),
  confirmPassword: z.string(),
}).refine((v) => v.password === v.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

export function RegisterPage() {
  const [params] = useSearchParams();
  const [kind, setKind] = useState<'customer' | 'manager'>(params.get('as') === 'manager' ? 'manager' : 'customer');
  const { register: signUp, user } = useAuth();
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) });
  const e = form.formState.errors;

  if (user) return <Navigate to={homeFor(user)} replace />;
  return (
    <AuthShell title="Create your account" subtitle={kind === 'customer' ? 'Book seats in under a minute.' : 'List your theatres. An admin reviews every new manager.'}>
      <div role="tablist" aria-label="Account type" className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-raised p-1 text-sm">
        {(['customer', 'manager'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={`rounded-lg py-2 transition ${kind === k ? 'bg-brand text-white' : 'text-muted hover:text-ink'}`}>{k === 'customer' ? 'Movie-goer' : 'Theatre manager'}</button>
        ))}
      </div>
      <form noValidate className="space-y-4" onSubmit={form.handleSubmit(async (v) => {
        try {
          const u = await signUp(kind, v);
          toast.success(kind === 'manager' ? 'Account created — awaiting admin approval.' : 'Welcome to CineBook!');
          navigate(homeFor(u), { replace: true });
        } catch (err) { toast.error(errorMessage(err)); }
      })}>
        <Input id="name" label="Full name" autoComplete="name" error={e.name?.message} {...form.register('name')} />
        <Input id="email" type="email" label="Email" autoComplete="email" error={e.email?.message} {...form.register('email')} />
        <Input id="password" type="password" label="Password" autoComplete="new-password" hint="8+ characters with a letter and a number" error={e.password?.message} {...form.register('password')} />
        <Input id="confirmPassword" type="password" label="Confirm password" autoComplete="new-password" error={e.confirmPassword?.message} {...form.register('confirmPassword')} />
        <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>{kind === 'manager' ? 'Request manager access' : 'Create account'}</Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">Already registered? <Link to="/login" className="text-brand hover:underline">Sign in</Link></p>
    </AuthShell>
  );
}

interface AccountStatus {
  accountStatus: 'PENDING_APPROVAL' | 'ACTIVE' | 'REJECTED' | 'SUSPENDED';
  rejectionReason: string | null;
}

export function PendingApprovalPage() {
  const { user, logout, refresh } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['manager-status'],
    queryFn: () => api.get<AccountStatus>('/api/manager/account-status'),
    refetchInterval: 30_000,
    enabled: user?.role === 'THEATRE_MANAGER',
  });
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'THEATRE_MANAGER') return <Navigate to={homeFor(user)} replace />;
  if (isLoading) return <Spinner />;
  if (data?.accountStatus === 'ACTIVE') return <Navigate to="/manager" replace />;
  const rejected = data?.accountStatus === 'REJECTED';

  return (
    <AuthShell title={rejected ? 'Application not approved' : 'Awaiting approval'} subtitle={rejected ? 'An administrator reviewed your manager request.' : `Hi ${user.name.split(' ')[0]}, your manager account is being reviewed.`}>
      <div className="flex flex-col items-center py-4 text-center">
        {rejected ? <XCircle className="h-14 w-14 text-bad" aria-hidden /> : <Clock className="h-14 w-14 text-warn" aria-hidden />}
        <p className="mt-4 text-sm text-muted">
          {rejected ? 'Reason from the administrator:' : 'You can add theatres as soon as an administrator approves your account. This page updates automatically.'}
        </p>
        {rejected && <p className="mt-2 rounded-xl border border-bad/30 bg-bad/10 px-4 py-3 text-sm text-bad">{data?.rejectionReason ?? 'No reason was provided.'}</p>}
      </div>
      <div className="flex gap-3">
        <Button variant="secondary" className="flex-1" loading={isFetching} onClick={async () => { await refetch(); await refresh(); if (data?.accountStatus === 'ACTIVE') navigate('/manager'); }}>Check status</Button>
        <Button variant="ghost" onClick={() => { logout(); navigate('/'); }}>Sign out</Button>
      </div>
    </AuthShell>
  );
}

export function ForbiddenPage() {
  return (
    <AuthShell title="No access" subtitle="Your account doesn't have permission to view that page.">
      <div className="flex flex-col items-center gap-4 py-2"><ShieldX className="h-12 w-12 text-bad" aria-hidden /><Link to="/"><Button variant="secondary">Back to home</Button></Link></div>
    </AuthShell>
  );
}

export function NotFoundPage() {
  return (
    <AuthShell title="Page not found" subtitle="That page doesn't exist or has moved.">
      <Link to="/"><Button className="w-full">Back to home</Button></Link>
    </AuthShell>
  );
}
