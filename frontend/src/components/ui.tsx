import clsx from 'clsx';
import { AlertTriangle, ChevronLeft, ChevronRight, Film, Loader2 } from 'lucide-react';
import { ButtonHTMLAttributes, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, useEffect, useRef, useState } from 'react';
import type { PageMeta } from '../lib/api';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-dim shadow-glow',
  secondary: 'bg-raised text-ink border border-line hover:border-muted/50',
  ghost: 'text-muted hover:text-ink hover:bg-raised',
  danger: 'bg-bad/15 text-bad border border-bad/30 hover:bg-bad/25',
  success: 'bg-ok/15 text-ok border border-ok/30 hover:bg-ok/25',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading, size = 'md', className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none',
        size === 'sm' && 'px-3 py-1.5 text-xs',
        size === 'md' && 'px-4 py-2.5 text-sm',
        size === 'lg' && 'px-6 py-3.5 text-base',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  id: string;
}

function FieldShell({ label, error, hint, id, children }: FieldProps & { children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-muted">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-bad">{error}</p>}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & Omit<FieldProps, 'id'> & { id: string }>(
  function Input({ label, error, hint, id, className, ...rest }, ref) {
    return (
      <FieldShell label={label} error={error} hint={hint} id={id}>
        <input ref={ref} id={id} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} className={clsx('input', error && 'border-bad/60', className)} {...rest} />
      </FieldShell>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & Omit<FieldProps, 'id'> & { id: string }>(
  function Textarea({ label, error, hint, id, className, ...rest }, ref) {
    return (
      <FieldShell label={label} error={error} hint={hint} id={id}>
        <textarea ref={ref} id={id} rows={3} aria-invalid={Boolean(error)} className={clsx('input', error && 'border-bad/60', className)} {...rest} />
      </FieldShell>
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & Omit<FieldProps, 'id'> & { id: string }>(
  function Select({ label, error, hint, id, className, children, ...rest }, ref) {
    return (
      <FieldShell label={label} error={error} hint={hint} id={id}>
        <select ref={ref} id={id} className={clsx('input', className)} {...rest}>{children}</select>
      </FieldShell>
    );
  },
);

const BADGE_TONES = {
  ok: 'bg-ok/12 text-ok border-ok/25',
  warn: 'bg-warn/12 text-warn border-warn/25',
  bad: 'bg-bad/12 text-bad border-bad/25',
  info: 'bg-info/12 text-info border-info/25',
  neutral: 'bg-raised text-muted border-line',
} as const;

const STATUS_TONE: Record<string, keyof typeof BADGE_TONES> = {
  ACTIVE: 'ok', APPROVED: 'ok', CONFIRMED: 'ok', SUCCESS: 'ok', SCHEDULED: 'ok',
  PENDING_APPROVAL: 'warn', HELD: 'warn', PROCESSING: 'warn',
  REJECTED: 'bad', SUSPENDED: 'bad', FAILED: 'bad', EXPIRED: 'neutral', CANCELLED: 'neutral',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace('_', ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</Badge>;
}

export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof BADGE_TONES; children: ReactNode }) {
  return <span className={clsx('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium', BADGE_TONES[tone])}>{children}</span>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('skeleton rounded-xl', className)} />;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-muted">
      <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> <span className="text-sm">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, text, action, icon }: { title: string; text?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-6 py-14 text-center">
      <div className="mb-3 rounded-full bg-raised p-3 text-muted">{icon ?? <Film className="h-6 w-6" aria-hidden />}</div>
      <p className="font-display text-lg">{title}</p>
      {text && <p className="mt-1 max-w-sm text-sm text-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-2xl border border-bad/30 bg-bad/5 px-6 py-10 text-center">
      <AlertTriangle className="mb-2 h-6 w-6 text-bad" aria-hidden />
      <p className="text-sm text-bad">{message}</p>
      {onRetry && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="card w-full max-w-md bg-surface p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary' | 'success';
  reasonRequired?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason?: string) => void;
}

/** Confirmation dialog; optionally collects a mandatory reason (for rejections/suspensions). */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', tone = 'primary', reasonRequired, busy, onCancel, onConfirm }: ConfirmProps) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const invalid = reasonRequired && reason.trim().length < 3;
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <div className="text-sm text-muted">{message}</div>
      {reasonRequired && (
        <div className="mt-4">
          <Textarea id="decision-reason" label="Reason (shown to the applicant)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant={tone} loading={busy} disabled={invalid} onClick={() => onConfirm(reasonRequired ? reason.trim() : undefined)}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}

export function Pagination({ meta, onPage }: { meta: PageMeta; onPage: (p: number) => void }) {
  if (meta.totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between pt-4 text-sm text-muted">
      <span>Page {meta.page} of {meta.totalPages} · {meta.total} total</span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)} aria-label="Previous page"><ChevronLeft className="h-4 w-4" /></Button>
        <Button variant="secondary" size="sm" disabled={meta.page >= meta.totalPages} onClick={() => onPage(meta.page + 1)} aria-label="Next page"><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </nav>
  );
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

export function DataTable<T>({ columns, rows, rowKey, empty }: { columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; empty?: ReactNode }) {
  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return (
    <div className="overflow-x-auto rounded-2xl border border-line">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-raised/60 text-xs uppercase tracking-wide text-muted">
          <tr>{columns.map((c) => <th key={c.header} scope="col" className={clsx('px-4 py-3 font-medium', c.className)}>{c.header}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={rowKey(r)} className="transition hover:bg-raised/40">
              {columns.map((c) => <td key={c.header} className={clsx('px-4 py-3 align-middle', c.className)}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => onChange(local), 300);
    return () => clearTimeout(t);
  }, [local, onChange]);
  return <input aria-label={placeholder} className="input max-w-xs" placeholder={placeholder} value={local} onChange={(e) => setLocal(e.target.value)} />;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
