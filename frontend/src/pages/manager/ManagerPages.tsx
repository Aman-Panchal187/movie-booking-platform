import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { ReportsView } from '../../components/ReportsView';
import { Badge, Button, ConfirmDialog, DataTable, EmptyState, ErrorState, Input, Modal, PageHeader, Pagination, Select, Skeleton, StatusBadge, Textarea } from '../../components/ui';
import { api, errorMessage, PageMeta } from '../../lib/api';
import { formatDateTime, formatMoney } from '../../lib/format';
import type { Movie } from '../../components/MovieCard';

export interface ManagerTheatre {
  id: string;
  name: string;
  city: string;
  address: string;
  contactNumber: string;
  description: string | null;
  approvalStatus: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  rejectionReason: string | null;
  screens?: Screen[];
}

interface Screen { id: string; name: string; isActive: boolean; seatCount: number }

export function useManagerTheatres() {
  return useQuery({ queryKey: ['manager-theatres'], queryFn: () => api.get<ManagerTheatre[]>('/api/manager/theatres') });
}

export function ManagerOverviewPage() {
  const { data } = useManagerTheatres();
  const approved = (data ?? []).filter((t) => t.approvalStatus === 'APPROVED');
  return (
    <>
      <PageHeader title="Overview" subtitle="Performance across your approved theatres." />
      {data && approved.length === 0 ? (
        <EmptyState title="No approved theatres yet" text="Submit a theatre for review. Reports appear once an admin approves it." action={<Link to="/manager/theatres/new"><Button><Plus className="h-4 w-4" /> Add theatre</Button></Link>} />
      ) : (
        <ReportsView scope="manager" theatres={approved.map((t) => ({ id: t.id, name: t.name }))} />
      )}
    </>
  );
}

const theatreSchema = z.object({
  name: z.string().trim().min(2, 'Enter the theatre name'),
  city: z.string().trim().min(2, 'Enter the city'),
  address: z.string().trim().min(5, 'Enter the full address'),
  contactNumber: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, 'Enter a valid phone number'),
  description: z.string().trim().max(1000).optional(),
});
type TheatreForm = z.infer<typeof theatreSchema>;

export function TheatreFormFields({ form }: { form: ReturnType<typeof useForm<TheatreForm>> }) {
  const e = form.formState.errors;
  return (
    <div className="space-y-4">
      <Input id="name" label="Theatre name" error={e.name?.message} {...form.register('name')} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Input id="city" label="City" error={e.city?.message} {...form.register('city')} />
        <Input id="contactNumber" label="Contact number" error={e.contactNumber?.message} {...form.register('contactNumber')} />
      </div>
      <Input id="address" label="Address" error={e.address?.message} {...form.register('address')} />
      <Textarea id="description" label="Description (optional)" error={e.description?.message} {...form.register('description')} />
    </div>
  );
}

export function NewTheatrePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const form = useForm<TheatreForm>({ resolver: zodResolver(theatreSchema) });
  const create = useMutation({
    mutationFn: (v: TheatreForm) => api.post<ManagerTheatre>('/api/manager/theatres', { ...v, description: v.description || null }),
    onSuccess: async ({ data }) => {
      await qc.invalidateQueries({ queryKey: ['manager-theatres'] });
      toast.success('Submitted for admin review.');
      navigate(`/manager/theatres/${data.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="max-w-2xl">
      <PageHeader title="Add new theatre" subtitle="An administrator reviews every theatre before it goes live." />
      <form noValidate className="card space-y-6 p-6" onSubmit={form.handleSubmit((v) => create.mutate(v))}>
        <TheatreFormFields form={form} />
        <Button type="submit" loading={create.isPending}>Submit for approval</Button>
      </form>
    </div>
  );
}

export function ManagerTheatresPage() {
  const { data, error, isLoading, refetch } = useManagerTheatres();
  return (
    <>
      <PageHeader title="My theatres" subtitle="Approved, pending, rejected and suspended theatres." actions={<Link to="/manager/theatres/new"><Button><Plus className="h-4 w-4" aria-hidden /> Add new theatre</Button></Link>} />
      {isLoading && <Skeleton className="h-48" />}
      {error && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}
      {data && (
        <DataTable rows={data} rowKey={(t) => t.id}
          empty={<EmptyState title="No theatres yet" text="Add your first theatre to start selling tickets." action={<Link to="/manager/theatres/new"><Button>Add new theatre</Button></Link>} />}
          columns={[
            { header: 'Theatre', cell: (t) => <Link to={`/manager/theatres/${t.id}`} className="font-medium hover:text-brand">{t.name}</Link> },
            { header: 'City', cell: (t) => t.city },
            { header: 'Status', cell: (t) => <StatusBadge status={t.approvalStatus} /> },
            { header: 'Note', cell: (t) => <span className="text-xs text-muted">{t.rejectionReason ?? ''}</span> },
          ]} />
      )}
    </>
  );
}

const screenSchema = z.object({
  name: z.string().trim().min(1, 'Name the screen'),
  rows: z.coerce.number().int().min(1).max(20),
  seatsPerRow: z.coerce.number().int().min(1).max(30),
  premiumRows: z.coerce.number().int().min(0).max(10),
  reclinerRows: z.coerce.number().int().min(0).max(5),
});
type ScreenForm = z.input<typeof screenSchema>;

const showSchema = z.object({
  movieId: z.string().uuid('Choose a movie'),
  screenId: z.string().uuid('Choose a screen'),
  startTime: z.string().min(1, 'Choose date and time'),
  standard: z.coerce.number().min(0),
  premium: z.coerce.number().min(0),
  recliner: z.coerce.number().min(0),
});
type ShowForm = z.input<typeof showSchema>;

interface ManagedShow { id: string; status: string; startTime: string; movieTitle: string; screenName: string; totalSeats: number; bookedSeats: number; revenueMinor: number }

export function ManagerTheatreDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [screenOpen, setScreenOpen] = useState(false);
  const [showOpen, setShowOpen] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const theatre = useQuery({ queryKey: ['manager-theatre', id], queryFn: () => api.get<ManagerTheatre>(`/api/manager/theatres/${id}`) });
  const approved = theatre.data?.approvalStatus === 'APPROVED';
  const shows = useQuery({ queryKey: ['manager-shows', id, page], enabled: approved, queryFn: () => api.list<ManagedShow>(`/api/manager/shows?theatreId=${id}&page=${page}&pageSize=10`) });
  const movies = useQuery({ queryKey: ['movies', {}], queryFn: () => api.get<Movie[]>('/api/movies'), enabled: showOpen });

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['manager-theatre', id] }); void qc.invalidateQueries({ queryKey: ['manager-shows', id] }); void qc.invalidateQueries({ queryKey: ['manager-theatres'] }); };

  const screenForm = useForm<ScreenForm>({ resolver: zodResolver(screenSchema), defaultValues: { name: '', rows: 8, seatsPerRow: 12, premiumRows: 2, reclinerRows: 1 } });
  const addScreen = useMutation({
    mutationFn: (v: ScreenForm) => api.post(`/api/manager/theatres/${id}/screens`, screenSchema.parse(v)),
    onSuccess: () => { toast.success('Screen and seat layout created.'); setScreenOpen(false); screenForm.reset(); refresh(); },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const showForm = useForm<ShowForm>({ resolver: zodResolver(showSchema), defaultValues: { standard: 250, premium: 350, recliner: 550 } });
  const addShow = useMutation({
    mutationFn: (v: ShowForm) => {
      const p = showSchema.parse(v);
      return api.post('/api/manager/shows', {
        movieId: p.movieId, screenId: p.screenId, startTime: new Date(p.startTime).toISOString(),
        prices: { STANDARD: Math.round(p.standard * 100), PREMIUM: Math.round(p.premium * 100), RECLINER: Math.round(p.recliner * 100) },
      });
    },
    onSuccess: () => { toast.success('Show scheduled.'); setShowOpen(false); refresh(); },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const cancel = useMutation({
    mutationFn: (showId: string) => api.patch(`/api/manager/shows/${showId}/cancel`, {}),
    onSuccess: () => { toast.success('Show cancelled.'); setCancelId(null); refresh(); },
    onError: (err) => { toast.error(errorMessage(err)); setCancelId(null); },
  });

  const editForm = useForm<TheatreForm>({ resolver: zodResolver(theatreSchema), values: theatre.data ? { name: theatre.data.name, city: theatre.data.city, address: theatre.data.address, contactNumber: theatre.data.contactNumber, description: theatre.data.description ?? '' } : undefined });
  const resubmit = useMutation({
    mutationFn: (v: TheatreForm) => api.patch(`/api/manager/theatres/${id}`, { ...v, description: v.description || null }),
    onSuccess: () => { toast.success('Resubmitted for review.'); refresh(); },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (theatre.isLoading) return <Skeleton className="h-64" />;
  if (theatre.error || !theatre.data) return <ErrorState message={errorMessage(theatre.error)} />;
  const t = theatre.data;
  const se = screenForm.formState.errors;
  const sh = showForm.formState.errors;

  return (
    <>
      <PageHeader title={t.name} subtitle={`${t.address}, ${t.city} · ${t.contactNumber}`} actions={<StatusBadge status={t.approvalStatus} />} />

      {t.approvalStatus === 'PENDING_APPROVAL' && <div className="card mb-6 border-warn/30 bg-warn/5 p-5 text-sm text-warn">Awaiting admin review. You can configure screens and shows once it is approved.</div>}
      {t.approvalStatus === 'SUSPENDED' && <div className="card mb-6 border-bad/30 bg-bad/5 p-5 text-sm text-bad">This theatre is suspended{t.rejectionReason ? `: ${t.rejectionReason}` : '.'} It is hidden from customers.</div>}
      {t.approvalStatus === 'REJECTED' && (
        <form noValidate className="card mb-6 space-y-4 border-bad/30 p-6" onSubmit={editForm.handleSubmit((v) => resubmit.mutate(v))}>
          <div><h2 className="text-lg font-semibold text-bad">Not approved</h2><p className="text-sm text-muted">Reason: {t.rejectionReason ?? 'not provided'}. Update the details and resubmit.</p></div>
          <TheatreFormFields form={editForm} />
          <Button type="submit" loading={resubmit.isPending}>Resubmit for approval</Button>
        </form>
      )}

      {approved && (
        <div className="space-y-8">
          <section>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-xl font-semibold">Screens</h2><Button size="sm" onClick={() => setScreenOpen(true)}><Plus className="h-4 w-4" aria-hidden /> Add screen</Button></div>
            <DataTable rows={t.screens ?? []} rowKey={(s) => s.id} empty={<EmptyState title="No screens yet" text="Define a screen and its seat layout to schedule shows." />}
              columns={[{ header: 'Screen', cell: (s) => <span className="font-medium">{s.name}</span> }, { header: 'Seats', cell: (s) => s.seatCount }, { header: 'Status', cell: (s) => <Badge tone={s.isActive ? 'ok' : 'neutral'}>{s.isActive ? 'Active' : 'Inactive'}</Badge> }]} />
          </section>
          <section>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-xl font-semibold">Shows</h2><Button size="sm" disabled={(t.screens ?? []).length === 0} onClick={() => setShowOpen(true)}><Plus className="h-4 w-4" aria-hidden /> Schedule show</Button></div>
            {shows.data && (
              <>
                <DataTable rows={shows.data.rows} rowKey={(s) => s.id} empty={<EmptyState title="No shows scheduled" />}
                  columns={[
                    { header: 'Movie', cell: (s) => <span className="font-medium">{s.movieTitle}</span> },
                    { header: 'Screen', cell: (s) => s.screenName },
                    { header: 'Starts', cell: (s) => formatDateTime(s.startTime) },
                    { header: 'Occupancy', cell: (s) => `${s.bookedSeats}/${s.totalSeats}` },
                    { header: 'Revenue', cell: (s) => formatMoney(s.revenueMinor) },
                    { header: 'Status', cell: (s) => <StatusBadge status={s.status} /> },
                    { header: '', cell: (s) => s.status === 'SCHEDULED' && new Date(s.startTime) > new Date() ? <Button size="sm" variant="ghost" onClick={() => setCancelId(s.id)}>Cancel</Button> : null },
                  ]} />
                <Pagination meta={shows.data.meta as PageMeta} onPage={setPage} />
              </>
            )}
            <p className="mt-3 text-xs text-muted">Shows with held or confirmed bookings can't be cancelled or repriced in this version, so no sold ticket is ever invalidated.</p>
          </section>
        </div>
      )}

      <Modal open={screenOpen} onClose={() => setScreenOpen(false)} title="Add screen">
        <form noValidate className="space-y-4" onSubmit={screenForm.handleSubmit((v) => addScreen.mutate(v))}>
          <Input id="screen-name" label="Screen name" error={se.name?.message} {...screenForm.register('name')} />
          <div className="grid grid-cols-2 gap-3">
            <Input id="rows" type="number" label="Rows (A…)" error={se.rows?.message} {...screenForm.register('rows')} />
            <Input id="per" type="number" label="Seats per row" error={se.seatsPerRow?.message} {...screenForm.register('seatsPerRow')} />
            <Input id="prem" type="number" label="Premium rows" hint="Back rows" error={se.premiumRows?.message} {...screenForm.register('premiumRows')} />
            <Input id="rec" type="number" label="Recliner rows" hint="Very back" error={se.reclinerRows?.message} {...screenForm.register('reclinerRows')} />
          </div>
          <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={() => setScreenOpen(false)}>Cancel</Button><Button type="submit" loading={addScreen.isPending}>Create layout</Button></div>
        </form>
      </Modal>

      <Modal open={showOpen} onClose={() => setShowOpen(false)} title="Schedule a show">
        <form noValidate className="space-y-4" onSubmit={showForm.handleSubmit((v) => addShow.mutate(v))}>
          <Select id="movieId" label="Movie" error={sh.movieId?.message} defaultValue="" {...showForm.register('movieId')}>
            <option value="" disabled>Select…</option>{movies.data?.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </Select>
          <Select id="screenId" label="Screen" error={sh.screenId?.message} defaultValue="" {...showForm.register('screenId')}>
            <option value="" disabled>Select…</option>{t.screens?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
          <Input id="startTime" type="datetime-local" label="Start (your local time)" error={sh.startTime?.message} {...showForm.register('startTime')} />
          <div className="grid grid-cols-3 gap-3">
            <Input id="p1" type="number" label="Standard ₹" {...showForm.register('standard')} />
            <Input id="p2" type="number" label="Premium ₹" {...showForm.register('premium')} />
            <Input id="p3" type="number" label="Recliner ₹" {...showForm.register('recliner')} />
          </div>
          <p className="text-xs text-muted">Overlapping shows on the same screen are rejected by the database.</p>
          <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={() => setShowOpen(false)}>Cancel</Button><Button type="submit" loading={addShow.isPending}>Schedule</Button></div>
        </form>
      </Modal>

      <ConfirmDialog open={Boolean(cancelId)} title="Cancel this show?" tone="danger" confirmLabel="Cancel show" busy={cancel.isPending}
        message="The show is removed from sale. This only works while there are no held or confirmed bookings." onCancel={() => setCancelId(null)} onConfirm={() => cancelId && cancel.mutate(cancelId)} />
    </>
  );
}
