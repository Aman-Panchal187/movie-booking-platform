import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Upload } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import type { Movie } from '../../components/MovieCard';
import { ReportsView } from '../../components/ReportsView';
import { Badge, Button, ConfirmDialog, DataTable, ErrorState, Input, Modal, PageHeader, Pagination, SearchBox, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, errorMessage, PageMeta, qs } from '../../lib/api';
import { formatDateTime, formatMoney } from '../../lib/format';

/** Fetches one page of an admin list endpoint with search + status filter state. */
function useAdminList<T>(path: string, extra: Record<string, string | undefined> = {}) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const query = useQuery({
    queryKey: ['admin-list', path, page, q, status, extra],
    queryFn: () => api.list<T>(`${path}${qs({ page, pageSize: 10, q, status, ...extra })}`),
    placeholderData: (prev) => prev,
  });
  return { query, page, setPage, q, setQ: (v: string) => { setQ(v); setPage(1); }, status, setStatus: (v: string) => { setStatus(v); setPage(1); } };
}

function ListShell<T>({ list, columns, rowKey, statuses, searchPlaceholder }: {
  list: ReturnType<typeof useAdminList<T>>;
  columns: Parameters<typeof DataTable<T>>[0]['columns'];
  rowKey: (r: T) => string;
  statuses?: string[];
  searchPlaceholder?: string;
}) {
  const { query } = list;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchBox value={list.q} onChange={list.setQ} placeholder={searchPlaceholder} />
        {statuses && (
          <select aria-label="Status filter" className="input w-auto" value={list.status} onChange={(e) => list.setStatus(e.target.value)}>
            <option value="">All statuses</option>{statuses.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        )}
      </div>
      {query.isLoading && <Skeleton className="h-64" />}
      {query.error && <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} />}
      {query.data && (<><DataTable rows={query.data.rows} rowKey={rowKey} columns={columns} /><Pagination meta={query.data.meta as PageMeta} onPage={list.setPage} /></>)}
    </>
  );
}

export function AdminOverviewPage() {
  const theatres = useQuery({ queryKey: ['admin-theatre-options'], queryFn: () => api.list<{ id: string; name: string; approvalStatus: string }>('/api/admin/theatre-requests?status=APPROVED&pageSize=100') });
  return (
    <>
      <PageHeader title="Platform overview" subtitle="Live numbers computed from confirmed mock payments." />
      <ReportsView scope="admin" theatres={(theatres.data?.rows ?? []).map((t) => ({ id: t.id, name: t.name }))} />
    </>
  );
}

interface ManagerRow { id: string; name: string; email: string; accountStatus: string; rejectionReason: string | null; createdAt: string; theatreCount: number }
type Decision = { id: string; name: string; action: string; label: string; tone: 'danger' | 'success' | 'primary'; reason: boolean };

export function ManagerApprovalsPage() {
  const qc = useQueryClient();
  const list = useAdminList<ManagerRow>('/api/admin/manager-requests', {});
  const [pending, setPending] = useState<Decision | null>(null);
  const decide = useMutation({
    mutationFn: ({ d, reason }: { d: Decision; reason?: string }) => api.patch(`/api/admin/manager-requests/${d.id}`, { action: d.action, reason }),
    onSuccess: () => { toast.success('Decision saved.'); setPending(null); void qc.invalidateQueries({ queryKey: ['admin-list'] }); },
    onError: (err) => { toast.error(errorMessage(err)); setPending(null); },
  });
  const act = (r: ManagerRow, action: string, label: string, tone: Decision['tone'], reason = false) => setPending({ id: r.id, name: r.name, action, label, tone, reason });

  return (
    <>
      <PageHeader title="Manager approvals" subtitle="Review theatre-manager accounts. Pending requests are listed first." />
      <ListShell list={list} rowKey={(r) => r.id} statuses={['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED']} searchPlaceholder="Search name or email"
        columns={[
          { header: 'Manager', cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.email}</p></div> },
          { header: 'Status', cell: (r) => <StatusBadge status={r.accountStatus} /> },
          { header: 'Theatres', cell: (r) => r.theatreCount },
          { header: 'Registered', cell: (r) => formatDateTime(r.createdAt) },
          { header: 'Actions', cell: (r) => (
            <div className="flex flex-wrap gap-2">
              {r.accountStatus === 'PENDING_APPROVAL' && <><Button size="sm" variant="success" onClick={() => act(r, 'APPROVE', 'Approve', 'success')}>Approve</Button><Button size="sm" variant="danger" onClick={() => act(r, 'REJECT', 'Reject', 'danger', true)}>Reject</Button></>}
              {r.accountStatus === 'REJECTED' && <Button size="sm" variant="success" onClick={() => act(r, 'APPROVE', 'Approve', 'success')}>Approve</Button>}
              {r.accountStatus === 'ACTIVE' && <Button size="sm" variant="danger" onClick={() => act(r, 'SUSPEND', 'Suspend', 'danger', true)}>Suspend</Button>}
              {r.accountStatus === 'SUSPENDED' && <Button size="sm" variant="secondary" onClick={() => act(r, 'REACTIVATE', 'Reactivate', 'primary')}>Reactivate</Button>}
            </div>) },
        ]} />
      <ConfirmDialog open={Boolean(pending)} title={`${pending?.label} ${pending?.name}?`} tone={pending?.tone} confirmLabel={pending?.label} reasonRequired={pending?.reason} busy={decide.isPending}
        message={pending?.action === 'APPROVE' ? 'They gain access to the manager dashboard and can submit theatres.' : pending?.action === 'REACTIVATE' ? 'Their access is restored.' : 'Their access is restricted immediately, even for existing sessions.'}
        onCancel={() => setPending(null)} onConfirm={(reason) => pending && decide.mutate({ d: pending, reason })} />
    </>
  );
}

interface TheatreRow {
  id: string; name: string; city: string; address: string; contactNumber: string; description: string | null;
  approvalStatus: string; rejectionReason: string | null; createdAt: string; submittedByName: string; submittedByEmail: string;
  managers: { managerId: string; name: string; email: string }[];
}

export function TheatreApprovalsPage() {
  const qc = useQueryClient();
  const list = useAdminList<TheatreRow>('/api/admin/theatre-requests', {});
  const [pending, setPending] = useState<{ t: TheatreRow; action: string; label: string; tone: Decision['tone']; reason: boolean } | null>(null);
  const [assignFor, setAssignFor] = useState<TheatreRow | null>(null);
  const [managerId, setManagerId] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-list'] });

  const managers = useQuery({ queryKey: ['active-managers'], enabled: Boolean(assignFor), queryFn: () => api.list<ManagerRow>('/api/admin/manager-requests?status=ACTIVE&pageSize=100') });
  const decide = useMutation({
    mutationFn: ({ t, action, reason }: { t: TheatreRow; action: string; reason?: string }) => api.patch(`/api/admin/theatre-requests/${t.id}`, { action, reason }),
    onSuccess: () => { toast.success('Decision saved.'); setPending(null); refresh(); },
    onError: (err) => { toast.error(errorMessage(err)); setPending(null); },
  });
  const assign = useMutation({
    mutationFn: () => api.post(`/api/admin/theatres/${assignFor!.id}/managers`, { managerId }),
    onSuccess: () => { toast.success('Manager assigned.'); setAssignFor(null); setManagerId(''); refresh(); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: ({ t, id }: { t: TheatreRow; id: string }) => api.del(`/api/admin/theatres/${t.id}/managers/${id}`),
    onSuccess: () => { toast.success('Assignment revoked.'); refresh(); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const ask = (t: TheatreRow, action: string, label: string, tone: Decision['tone'], reason = false) => setPending({ t, action, label, tone, reason });

  return (
    <>
      <PageHeader title="Theatre approvals" subtitle="Every theatre is reviewed on its own. Approving creates the manager assignment." />
      <ListShell list={list} rowKey={(r) => r.id} statuses={['PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUSPENDED']} searchPlaceholder="Search theatre or city"
        columns={[
          { header: 'Theatre', cell: (t) => <div><p className="font-medium">{t.name}</p><p className="text-xs text-muted">{t.address}</p><p className="text-xs text-muted">{t.contactNumber}</p></div> },
          { header: 'Submitted by', cell: (t) => <div><p>{t.submittedByName}</p><p className="text-xs text-muted">{t.submittedByEmail}</p></div> },
          { header: 'Status', cell: (t) => <div><StatusBadge status={t.approvalStatus} />{t.rejectionReason && <p className="mt-1 max-w-[180px] text-xs text-muted">{t.rejectionReason}</p>}</div> },
          { header: 'Managers', cell: (t) => (
            <div className="space-y-1">{t.managers.map((m) => (
              <div key={m.managerId} className="flex items-center gap-1 text-xs"><Badge>{m.name}</Badge>
                <button aria-label={`Revoke ${m.name}`} className="text-bad hover:underline" onClick={() => revoke.mutate({ t, id: m.managerId })}>revoke</button></div>))}
              {t.approvalStatus === 'APPROVED' && <button className="text-xs text-brand hover:underline" onClick={() => setAssignFor(t)}>+ assign manager</button>}</div>) },
          { header: 'Actions', cell: (t) => (
            <div className="flex flex-wrap gap-2">
              {t.approvalStatus === 'PENDING_APPROVAL' && <><Button size="sm" variant="success" onClick={() => ask(t, 'APPROVE', 'Approve', 'success')}>Approve</Button><Button size="sm" variant="danger" onClick={() => ask(t, 'REJECT', 'Reject', 'danger', true)}>Reject</Button></>}
              {t.approvalStatus === 'APPROVED' && <Button size="sm" variant="danger" onClick={() => ask(t, 'SUSPEND', 'Suspend', 'danger', true)}>Suspend</Button>}
              {t.approvalStatus === 'SUSPENDED' && <Button size="sm" variant="secondary" onClick={() => ask(t, 'REINSTATE', 'Reinstate', 'primary')}>Reinstate</Button>}
            </div>) },
        ]} />
      <ConfirmDialog open={Boolean(pending)} title={`${pending?.label} ${pending?.t.name}?`} tone={pending?.tone} confirmLabel={pending?.label} reasonRequired={pending?.reason} busy={decide.isPending}
        message={pending?.action === 'APPROVE' ? 'The theatre goes live and its submitter is assigned as manager.' : pending?.action === 'REINSTATE' ? 'The theatre returns to the public catalog.' : 'The theatre disappears from public booking.'}
        onCancel={() => setPending(null)} onConfirm={(reason) => pending && decide.mutate({ t: pending.t, action: pending.action, reason })} />
      <Modal open={Boolean(assignFor)} onClose={() => setAssignFor(null)} title={`Assign manager to ${assignFor?.name ?? ''}`}>
        <Select id="assign-manager" label="Approved manager" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">Select…</option>{managers.data?.rows.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.email})</option>)}
        </Select>
        <div className="mt-6 flex justify-end gap-2"><Button variant="ghost" onClick={() => setAssignFor(null)}>Cancel</Button><Button disabled={!managerId} loading={assign.isPending} onClick={() => assign.mutate()}>Assign</Button></div>
      </Modal>
    </>
  );
}

interface UserRow { id: string; name: string; email: string; role: string; accountStatus: string; createdAt: string }

export function UsersPage() {
  const qc = useQueryClient();
  const [role, setRole] = useState('');
  const list = useAdminList<UserRow>('/api/admin/users', { role: role || undefined });
  const [target, setTarget] = useState<{ u: UserRow; suspend: boolean } | null>(null);
  const change = useMutation({
    mutationFn: ({ u, suspend, reason }: { u: UserRow; suspend: boolean; reason?: string }) => api.patch(`/api/admin/users/${u.id}/status`, { action: suspend ? 'SUSPEND' : 'REACTIVATE', reason }),
    onSuccess: () => { toast.success('Account updated.'); setTarget(null); void qc.invalidateQueries({ queryKey: ['admin-list'] }); },
    onError: (err) => { toast.error(errorMessage(err)); setTarget(null); },
  });
  return (
    <>
      <PageHeader title="Users" subtitle="Customers, managers and admins. Credentials are never shown." />
      <div className="mb-4"><select aria-label="Role filter" className="input w-auto" value={role} onChange={(e) => setRole(e.target.value)}><option value="">All roles</option><option value="CUSTOMER">Customers</option><option value="THEATRE_MANAGER">Managers</option><option value="ADMIN">Admins</option></select></div>
      <ListShell list={list} rowKey={(r) => r.id} statuses={['ACTIVE', 'PENDING_APPROVAL', 'REJECTED', 'SUSPENDED']} searchPlaceholder="Search name or email"
        columns={[
          { header: 'User', cell: (u) => <div><p className="font-medium">{u.name}</p><p className="text-xs text-muted">{u.email}</p></div> },
          { header: 'Role', cell: (u) => <Badge tone="info">{u.role.replace('_', ' ').toLowerCase()}</Badge> },
          { header: 'Status', cell: (u) => <StatusBadge status={u.accountStatus} /> },
          { header: 'Joined', cell: (u) => formatDateTime(u.createdAt) },
          { header: '', cell: (u) => u.role === 'ADMIN' ? null : u.accountStatus === 'SUSPENDED'
            ? <Button size="sm" variant="secondary" onClick={() => setTarget({ u, suspend: false })}>Reactivate</Button>
            : <Button size="sm" variant="danger" onClick={() => setTarget({ u, suspend: true })}>Suspend</Button> },
        ]} />
      <ConfirmDialog open={Boolean(target)} title={`${target?.suspend ? 'Suspend' : 'Reactivate'} ${target?.u.name}?`} tone={target?.suspend ? 'danger' : 'primary'} reasonRequired={target?.suspend} busy={change.isPending}
        confirmLabel={target?.suspend ? 'Suspend' : 'Reactivate'} message={target?.suspend ? 'They are signed out of every session immediately.' : 'They can sign in again.'}
        onCancel={() => setTarget(null)} onConfirm={(reason) => target && change.mutate({ ...target, reason })} />
    </>
  );
}

const movieSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  description: z.string().trim().max(4000),
  language: z.string().trim().min(1, 'Required'),
  genre: z.string().trim().min(1, 'Required'),
  durationMinutes: z.coerce.number().int().min(1).max(600),
  certification: z.string().trim().min(1).max(10),
  releaseDate: z.string().optional(),
  posterUrl: z.string().trim().refine((v) => v === '' || v.startsWith('https://'), 'Must be an https URL').optional(),
  bannerUrl: z.string().trim().refine((v) => v === '' || v.startsWith('https://'), 'Must be an https URL').optional(),
  trailerUrl: z.string().trim().refine((v) => v === '' || v.startsWith('https://'), 'Must be an https URL').optional(),
});
type MovieForm = z.input<typeof movieSchema>;

export function AdminMoviesPage() {
  const qc = useQueryClient();
  const list = useAdminList<Movie>('/api/admin/movies', {});
  const [editing, setEditing] = useState<Movie | 'new' | null>(null);
  const [deactivate, setDeactivate] = useState<Movie | null>(null);
  const media = useQuery({ queryKey: ['media-status'], queryFn: () => api.get<{ cloudinaryConfigured: boolean }>('/api/admin/media/status') });
  const form = useForm<MovieForm>({ resolver: zodResolver(movieSchema) });
  const e = form.formState.errors;

  const open = (m: Movie | 'new') => {
    setEditing(m);
    form.reset(m === 'new' ? { title: '', description: '', language: 'English', genre: '', durationMinutes: 120, certification: 'UA', releaseDate: '', posterUrl: '', bannerUrl: '', trailerUrl: '' }
      : { title: m.title, description: m.description, language: m.language, genre: m.genre, durationMinutes: m.durationMinutes, certification: m.certification, releaseDate: m.releaseDate?.slice(0, 10) ?? '', posterUrl: m.posterUrl ?? '', bannerUrl: m.bannerUrl ?? '', trailerUrl: m.trailerUrl ?? '' });
  };
  const save = useMutation({
    mutationFn: (v: MovieForm) => {
      const p = movieSchema.parse(v);
      const body = { ...p, releaseDate: p.releaseDate || null, posterUrl: p.posterUrl || null, bannerUrl: p.bannerUrl || null, trailerUrl: p.trailerUrl || null };
      return editing === 'new' ? api.post('/api/admin/movies', body) : api.patch(`/api/admin/movies/${(editing as Movie).id}`, body);
    },
    onSuccess: () => { toast.success('Movie saved.'); setEditing(null); void qc.invalidateQueries({ queryKey: ['admin-list'] }); void qc.invalidateQueries({ queryKey: ['movies'] }); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const toggle = useMutation({
    mutationFn: (m: Movie) => api.patch(`/api/admin/movies/${m.id}`, { isActive: !m.isActive }),
    onSuccess: () => { setDeactivate(null); void qc.invalidateQueries({ queryKey: ['admin-list'] }); void qc.invalidateQueries({ queryKey: ['movies'] }); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const upload = useMutation({
    mutationFn: ({ file, kind }: { file: File; kind: 'poster' | 'banner' }) => { const f = new FormData(); f.append('kind', kind); f.append('file', file); return api.upload<{ url: string }>('/api/admin/media/upload', f); },
    onSuccess: (r, { kind }) => { form.setValue(kind === 'poster' ? 'posterUrl' : 'bannerUrl', r.url, { shouldDirty: true }); toast.success('Uploaded to Cloudinary.'); },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <PageHeader title="Movies" subtitle="The public catalog." actions={<Button onClick={() => open('new')}><Plus className="h-4 w-4" aria-hidden /> Add movie</Button>} />
      <ListShell list={list} rowKey={(m) => m.id} searchPlaceholder="Search title"
        columns={[
          { header: 'Title', cell: (m) => <span className="font-medium">{m.title}</span> },
          { header: 'Genre', cell: (m) => `${m.genre} · ${m.language}` },
          { header: 'Rating', cell: (m) => m.certification },
          { header: 'Status', cell: (m) => <Badge tone={m.isActive ? 'ok' : 'neutral'}>{m.isActive ? 'Active' : 'Inactive'}</Badge> },
          { header: '', cell: (m) => <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => open(m)}>Edit</Button>
            {m.isActive ? <Button size="sm" variant="danger" onClick={() => setDeactivate(m)}>Deactivate</Button> : <Button size="sm" variant="success" onClick={() => toggle.mutate(m)}>Activate</Button>}</div> },
        ]} />
      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={editing === 'new' ? 'Add movie' : 'Edit movie'}>
        <form noValidate className="max-h-[70vh] space-y-4 overflow-y-auto pr-1" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
          <Input id="m-title" label="Title" error={e.title?.message} {...form.register('title')} />
          <Textarea id="m-desc" label="Synopsis" {...form.register('description')} />
          <div className="grid grid-cols-2 gap-3">
            <Input id="m-genre" label="Genre" error={e.genre?.message} {...form.register('genre')} />
            <Input id="m-lang" label="Language" error={e.language?.message} {...form.register('language')} />
            <Input id="m-dur" type="number" label="Minutes" error={e.durationMinutes?.message} {...form.register('durationMinutes')} />
            <Input id="m-cert" label="Certification" {...form.register('certification')} />
          </div>
          <Input id="m-release" type="date" label="Release date" {...form.register('releaseDate')} />
          {(['posterUrl', 'bannerUrl'] as const).map((k) => (
            <div key={k}>
              <Input id={`m-${k}`} label={k === 'posterUrl' ? 'Poster image URL (https)' : 'Banner image URL (https)'} error={e[k]?.message} {...form.register(k)} />
              <label className={`mt-1.5 inline-flex items-center gap-1.5 text-xs ${media.data?.cloudinaryConfigured ? 'cursor-pointer text-brand' : 'text-muted'}`}>
                <Upload className="h-3 w-3" aria-hidden />
                {media.data?.cloudinaryConfigured ? 'Upload to Cloudinary' : 'Cloudinary upload not configured — paste a URL'}
                {media.data?.cloudinaryConfigured && <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) upload.mutate({ file: f, kind: k === 'posterUrl' ? 'poster' : 'banner' }); }} />}
              </label>
            </div>
          ))}
          <Input id="m-trailer" label="Trailer URL (https embed or video)" error={e.trailerUrl?.message} {...form.register('trailerUrl')} />
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" loading={save.isPending}>Save</Button></div>
        </form>
      </Modal>
      <ConfirmDialog open={Boolean(deactivate)} title={`Deactivate ${deactivate?.title}?`} tone="danger" confirmLabel="Deactivate" busy={toggle.isPending}
        message="It disappears from the public catalog. Existing tickets stay valid." onCancel={() => setDeactivate(null)} onConfirm={() => deactivate && toggle.mutate(deactivate)} />
    </>
  );
}

interface BookingRow { id: string; reference: string; status: string; totalAmountMinor: number; createdAt: string; customerEmail: string; movieTitle: string; theatreName: string }
interface PaymentRow { id: string; status: string; amountMinor: number; transactionReference: string | null; createdAt: string; bookingReference: string; customerEmail: string }

export function BookingsPaymentsPage() {
  const [tab, setTab] = useState<'bookings' | 'payments'>('bookings');
  const bookings = useAdminList<BookingRow>('/api/admin/bookings', {});
  const payments = useAdminList<PaymentRow>('/api/admin/payments', {});
  return (
    <>
      <PageHeader title="Bookings & payments" subtitle="Platform-wide, read-only." />
      <div role="tablist" className="mb-4 inline-flex gap-1 rounded-xl bg-raised p-1 text-sm">
        {(['bookings', 'payments'] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-lg px-4 py-1.5 capitalize ${tab === k ? 'bg-brand text-white' : 'text-muted'}`}>{k}</button>)}
      </div>
      {tab === 'bookings' ? (
        <ListShell list={bookings} rowKey={(r) => r.id} statuses={['HELD', 'CONFIRMED', 'EXPIRED']} searchPlaceholder="Reference, email or movie"
          columns={[
            { header: 'Reference', cell: (r) => <span className="font-mono text-xs">{r.reference}</span> },
            { header: 'Movie', cell: (r) => <div><p>{r.movieTitle}</p><p className="text-xs text-muted">{r.theatreName}</p></div> },
            { header: 'Customer', cell: (r) => r.customerEmail },
            { header: 'Amount', cell: (r) => formatMoney(r.totalAmountMinor) },
            { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { header: 'Created', cell: (r) => formatDateTime(r.createdAt) },
          ]} />
      ) : (
        <ListShell list={payments} rowKey={(r) => r.id} statuses={['SUCCESS', 'FAILED']}
          columns={[
            { header: 'Transaction', cell: (r) => <span className="font-mono text-xs">{r.transactionReference ?? '—'}</span> },
            { header: 'Booking', cell: (r) => r.bookingReference },
            { header: 'Customer', cell: (r) => r.customerEmail },
            { header: 'Amount', cell: (r) => formatMoney(r.amountMinor) },
            { header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
            { header: 'When', cell: (r) => formatDateTime(r.createdAt) },
          ]} />
      )}
    </>
  );
}

interface AuditRow { id: string; entityType: string; action: string; previousStatus: string | null; newStatus: string | null; reason: string | null; createdAt: string; actorName: string; actorEmail: string }

export function AuditLogsPage() {
  const list = useAdminList<AuditRow>('/api/admin/audit-logs', {});
  return (
    <>
      <PageHeader title="Audit log" subtitle="Every approval, rejection, suspension and assignment." />
      <ListShell list={list} rowKey={(r) => r.id} searchPlaceholder="Actor or action"
        columns={[
          { header: 'When', cell: (r) => formatDateTime(r.createdAt) },
          { header: 'Actor', cell: (r) => <div><p>{r.actorName}</p><p className="text-xs text-muted">{r.actorEmail}</p></div> },
          { header: 'Action', cell: (r) => <Badge tone="info">{r.action.replaceAll('_', ' ').toLowerCase()}</Badge> },
          { header: 'Change', cell: (r) => <span className="text-xs text-muted">{r.previousStatus ?? '—'} → {r.newStatus ?? '—'}</span> },
          { header: 'Reason', cell: (r) => <span className="text-xs text-muted">{r.reason ?? ''}</span> },
        ]} />
    </>
  );
}
