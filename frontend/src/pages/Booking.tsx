import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, CreditCard, Printer, ShieldCheck, Ticket as TicketIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { z } from 'zod';
import { SafeImage } from '../components/common';
import { Countdown } from '../components/Countdown';
import { Seat, SeatMap } from '../components/SeatMap';
import { Badge, Button, EmptyState, ErrorState, Input, PageHeader, Pagination, Skeleton, Spinner, StatusBadge } from '../components/ui';
import { ApiError, api, errorMessage, PageMeta, request } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, formatLongDate, formatMoney } from '../lib/format';

const MAX_SEATS = 8;

interface SeatMapData {
  show: { id: string; startTime: string; status: string; movieTitle: string; posterUrl: string | null; certification: string; language: string; theatreName: string; city: string; screenName: string };
  seats: Seat[];
}

export interface BookingDetail {
  id: string;
  reference: string;
  status: 'HELD' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED' | 'PAYMENT_PROCESSING';
  totalAmountMinor: number;
  holdExpiresAt: string;
  serverNow: string;
  createdAt: string;
  showId: string;
  startTime: string;
  screenName: string;
  movieTitle: string;
  posterUrl: string | null;
  theatreName: string;
  city: string;
  ticketId: string | null;
  ticketNumber: string | null;
  seats: { showSeatId: string; label: string; seatType: string; priceMinor: number }[];
}

export function SeatSelectionPage() {
  const { showId = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Map<string, Seat>>(new Map());

  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['seats', showId],
    queryFn: () => api.get<SeatMapData>(`/api/shows/${showId}/seats`),
    refetchInterval: 15_000,
  });

  // Drop selections that someone else took while we were looking.
  useEffect(() => {
    if (!data) return;
    setSelected((prev) => {
      const free = new Map<string, Seat>();
      prev.forEach((s, id) => data.seats.find((x) => x.showSeatId === id)?.status === 'AVAILABLE' && free.set(id, s));
      return free.size === prev.size ? prev : free;
    });
  }, [data]);

  const hold = useMutation({
    mutationFn: () => api.post<BookingDetail>('/api/bookings/hold', { showId, showSeatIds: [...selected.keys()] }),
    onSuccess: ({ data: booking }) => navigate(`/checkout/${booking.id}`),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'SEATS_UNAVAILABLE') {
        toast.error('Someone just took one of those seats. Please choose again.');
        setSelected(new Map());
      } else toast.error(errorMessage(err));
      void qc.invalidateQueries({ queryKey: ['seats', showId] });
    },
  });

  const toggle = (seat: Seat) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(seat.showSeatId)) next.delete(seat.showSeatId);
      else if (next.size >= MAX_SEATS) toast.info(`You can select up to ${MAX_SEATS} seats.`);
      else next.set(seat.showSeatId, seat);
      return next;
    });

  if (isLoading) return <div className="mx-auto max-w-4xl space-y-4 px-4 py-10"><Skeleton className="h-24" /><Skeleton className="h-96" /></div>;
  if (error || !data) return <div className="mx-auto max-w-xl px-4 py-16"><ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /></div>;

  const { show } = data;
  const total = [...selected.values()].reduce((s, x) => s + x.priceMinor, 0);
  const closed = show.status !== 'SCHEDULED' || new Date(show.startTime) < new Date();

  const proceed = () => {
    if (!user) return navigate('/login', { state: { from: location.pathname } });
    if (user.role !== 'CUSTOMER') return toast.error('Please sign in with a customer account to book tickets.');
    hold.mutate();
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <PageHeader title={show.movieTitle} subtitle={`${show.theatreName}, ${show.city} · ${show.screenName} · ${formatLongDate(show.startTime)}`} />
      {closed ? <EmptyState title="Booking closed" text="This show is no longer open for booking." /> : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="card p-4 sm:p-8"><SeatMap seats={data.seats} selected={new Set(selected.keys())} onToggle={toggle} disabled={hold.isPending} /></div>
          <aside className="card h-fit space-y-4 p-5 lg:sticky lg:top-24" aria-label="Booking summary">
            <h2 className="text-lg font-semibold">Your selection</h2>
            {selected.size === 0 ? <p className="text-sm text-muted">Choose up to {MAX_SEATS} seats on the map.</p> : (
              <ul className="space-y-2 text-sm">
                {[...selected.values()].map((s) => (
                  <li key={s.showSeatId} className="flex justify-between"><span>{s.row}{s.number} <span className="text-xs text-muted">{s.seatType.toLowerCase()}</span></span><span>{formatMoney(s.priceMinor)}</span></li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between border-t border-line pt-4"><span className="text-muted">Total</span><span className="text-xl font-semibold" data-testid="seat-total">{formatMoney(total)}</span></div>
            <Button className="w-full" size="lg" disabled={selected.size === 0} loading={hold.isPending} onClick={proceed}>{user ? 'Hold seats & continue' : 'Sign in to continue'}</Button>
            <p className="text-xs text-muted">Seats are held for 5 minutes once you continue. Availability is confirmed by the server.</p>
          </aside>
        </div>
      )}
    </div>
  );
}

const cardSchema = z.object({
  cardHolder: z.string().trim().min(2, 'Enter the name on the card'),
  cardNumber: z.string().transform((v) => v.replace(/\s/g, '')).pipe(z.string().regex(/^\d{12,19}$/, 'Card number must be 12–19 digits')),
});
type CardForm = z.input<typeof cardSchema>;

export function CheckoutPage() {
  const { bookingId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [expired, setExpired] = useState(false);
  // One key per payment attempt: reused if the network drops (safe retry), replaced after any definitive answer.
  const keyRef = useRef(crypto.randomUUID());

  const { data: booking, error, isLoading } = useQuery({ queryKey: ['booking', bookingId], queryFn: () => api.get<BookingDetail>(`/api/bookings/${bookingId}`) });
  const form = useForm<CardForm>({ resolver: zodResolver(cardSchema), defaultValues: { cardHolder: '', cardNumber: '4242 4242 4242 4242' } });

  const pay = useMutation({
    mutationFn: async (values: CardForm) => {
      const parsed = cardSchema.parse(values);
      const res = await request<{ ticketId: string }>('/api/payments', {
        method: 'POST',
        body: { bookingId, amountMinor: booking!.totalAmountMinor, cardNumber: parsed.cardNumber, cardHolder: parsed.cardHolder },
        headers: { 'Idempotency-Key': keyRef.current },
        retry: false,
      });
      return res.data;
    },
    onSuccess: async (data) => {
      await qc.invalidateQueries({ queryKey: ['bookings'] });
      navigate(`/tickets/${data.ticketId}`, { replace: true });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status !== 0) keyRef.current = crypto.randomUUID();
      if (err instanceof ApiError && err.code === 'PAYMENT_DECLINED') toast.error('Card declined (mock). Try a different card number.');
      else if (err instanceof ApiError && err.code === 'HOLD_EXPIRED') setExpired(true);
      else toast.error(errorMessage(err));
    },
  });

  if (isLoading) return <Spinner label="Loading your booking" />;
  if (error || !booking) return <div className="mx-auto max-w-xl px-4 py-16"><ErrorState message={errorMessage(error)} /></div>;
  if (booking.status === 'CONFIRMED' && booking.ticketId) return <Navigate to={`/tickets/${booking.ticketId}`} replace />;

  const isExpired = expired || booking.status !== 'HELD';

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <PageHeader title="Checkout" actions={!isExpired ? <Countdown expiresAt={booking.holdExpiresAt} serverNow={booking.serverNow} onExpire={() => setExpired(true)} /> : undefined} />
      {isExpired ? (
        <EmptyState title="Your seat hold has expired" text="The seats were released so others can book them. No payment was taken." action={<Link to={`/shows/${booking.showId}`}><Button>Choose seats again</Button></Link>} />
      ) : (
        <div className="grid gap-6 md:grid-cols-[1fr_340px]">
          <form onSubmit={form.handleSubmit((v) => pay.mutate(v))} className="card space-y-5 p-6" noValidate>
            <h2 className="flex items-center gap-2 text-lg font-semibold"><CreditCard className="h-5 w-5 text-brand" aria-hidden /> Mock payment</h2>
            <p className="rounded-xl border border-info/25 bg-info/10 px-4 py-3 text-xs text-info">Demo only — no real charge. Any card number works; a number ending in <b>0002</b> simulates a decline.</p>
            <Input id="cardHolder" label="Name on card" autoComplete="cc-name" error={form.formState.errors.cardHolder?.message} {...form.register('cardHolder')} />
            <Input id="cardNumber" label="Card number" inputMode="numeric" autoComplete="cc-number" error={form.formState.errors.cardNumber?.message} {...form.register('cardNumber')} />
            <Button type="submit" size="lg" className="w-full" loading={pay.isPending}>Pay {formatMoney(booking.totalAmountMinor)}</Button>
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted"><ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Retrying a failed network request never double-charges.</p>
          </form>
          <aside className="card h-fit space-y-3 p-5" aria-label="Order summary">
            <div className="flex gap-3">
              <SafeImage src={booking.posterUrl} alt="" className="w-16 shrink-0 rounded-lg" />
              <div><p className="font-semibold">{booking.movieTitle}</p><p className="text-xs text-muted">{booking.theatreName}, {booking.city}</p><p className="text-xs text-muted">{formatDateTime(booking.startTime)} · {booking.screenName}</p></div>
            </div>
            <ul className="space-y-1.5 border-t border-line pt-3 text-sm">
              {booking.seats.map((s) => <li key={s.showSeatId} className="flex justify-between"><span>Seat {s.label}</span><span>{formatMoney(s.priceMinor)}</span></li>)}
            </ul>
            <div className="flex justify-between border-t border-line pt-3 font-semibold"><span>Total</span><span>{formatMoney(booking.totalAmountMinor)}</span></div>
          </aside>
        </div>
      )}
    </div>
  );
}

function Barcode({ value }: { value: string }) {
  // Decorative bar pattern derived from the ticket number (not a scannable code).
  const bars = [...value].flatMap((c) => [(c.charCodeAt(0) % 3) + 1, 1]);
  let x = 0;
  return (
    <svg viewBox={`0 0 ${bars.reduce((a, b) => a + b, 0)} 40`} className="h-12 w-full max-w-xs" preserveAspectRatio="none" aria-hidden>
      {bars.map((w, i) => { const rect = i % 2 === 0 ? <rect key={i} x={x} y={0} width={w} height={40} fill="currentColor" /> : null; x += w; return rect; })}
    </svg>
  );
}

export function TicketPage() {
  const { id = '' } = useParams();
  const { data, error, isLoading } = useQuery({ queryKey: ['ticket', id], queryFn: () => api.get<BookingDetail>(`/api/tickets/${id}`) });
  if (isLoading) return <Spinner label="Loading ticket" />;
  if (error || !data) return <div className="mx-auto max-w-xl px-4 py-16"><ErrorState message={errorMessage(error)} /></div>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <div className="no-print mb-6 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-ok" aria-hidden />
        <h1 className="mt-3 text-3xl font-semibold">Booking confirmed</h1>
        <p className="mt-1 text-sm text-muted">Booking reference <span className="font-mono text-ink">{data.reference}</span></p>
      </div>
      <article className="print-ticket card overflow-hidden" aria-label="Ticket">
        <div className="flex gap-4 bg-gradient-to-br from-brand/20 to-transparent p-6">
          <SafeImage src={data.posterUrl} alt="" className="w-20 shrink-0 rounded-lg" />
          <div>
            <h2 className="text-2xl font-semibold">{data.movieTitle}</h2>
            <p className="mt-1 text-sm text-muted">{data.theatreName}, {data.city}</p>
            <p className="text-sm text-muted">{data.screenName}</p>
            <p className="mt-2 text-sm font-medium">{formatLongDate(data.startTime)}</p>
          </div>
        </div>
        <div className="border-y border-dashed border-line px-6 py-5">
          <p className="label">Seats</p>
          <div className="flex flex-wrap gap-2">{data.seats.map((s) => <Badge key={s.showSeatId} tone="info">{s.label}</Badge>)}</div>
          <p className="mt-4 text-sm text-muted">Paid <span className="font-medium text-ink">{formatMoney(data.totalAmountMinor)}</span> · mock payment</p>
        </div>
        <div className="flex flex-col items-center gap-2 px-6 py-6 text-center">
          <p className="label">Ticket number</p>
          <p className="font-mono text-2xl tracking-widest" data-testid="ticket-number">{data.ticketNumber}</p>
          {data.ticketNumber && <Barcode value={data.ticketNumber} />}
        </div>
      </article>
      <div className="no-print mt-6 flex flex-wrap justify-center gap-3">
        <Button variant="secondary" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Print ticket</Button>
        <Link to="/bookings"><Button variant="ghost"><TicketIcon className="h-4 w-4" aria-hidden /> My bookings</Button></Link>
      </div>
    </div>
  );
}

export function MyBookingsPage() {
  const [page, setPage] = useState(1);
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['bookings', page],
    queryFn: async () => (await api.list<BookingDetail>(`/api/bookings?page=${page}&pageSize=10`)),
  });
  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <PageHeader title="My bookings" />
      {isLoading && <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>}
      {error && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}
      {data && data.rows.length === 0 && <EmptyState title="No bookings yet" text="Your tickets will appear here." action={<Link to="/movies"><Button>Browse movies</Button></Link>} />}
      <div className="space-y-3">
        {data?.rows.map((b) => (
          <div key={b.id} className="card flex flex-wrap items-center gap-4 p-4">
            <SafeImage src={b.posterUrl} alt="" className="w-14 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{b.movieTitle}</p>
              <p className="text-xs text-muted">{b.theatreName}, {b.city} · {formatDateTime(b.startTime)}</p>
              <p className="mt-1 text-xs text-muted">{b.seats.map((s) => s.label).join(', ')} · {b.reference}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-medium">{formatMoney(b.totalAmountMinor)}</span>
              <StatusBadge status={b.status} />
              {b.ticketId ? <Link to={`/tickets/${b.ticketId}`}><Button size="sm" variant="secondary">View ticket</Button></Link>
                : b.status === 'HELD' ? <Link to={`/checkout/${b.id}`}><Button size="sm">Pay now</Button></Link> : null}
            </div>
          </div>
        ))}
      </div>
      {data && <Pagination meta={data.meta as PageMeta} onPage={setPage} />}
    </div>
  );
}
