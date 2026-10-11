import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorMessage, qs } from '../lib/api';
import { formatMoney, formatTime } from '../lib/format';
import { BookingTrendLine, ChartCard, DailyRevenueBars, DonutChart, Kpi, RankedBars } from './charts';
import { Button, ErrorState, Skeleton } from './ui';

type Range = 'today' | '7d' | '30d' | 'custom';

interface Series { day: string; bookings: number; tickets: number; revenueMinor: number }
interface Summary {
  bookings: number; tickets: number; revenueMinor: number; avgOccupancyPct: number; activeShows: number;
  customers?: number; managers?: number; approvedTheatres?: number; pendingManagers?: number; pendingTheatres?: number;
}
interface ByMovie { movieId: string; movieTitle: string; bookings: number; tickets: number; revenueMinor: number }
interface ShowOcc { showId: string; movieTitle: string; theatreName: string; startTime: string; occupancyPct: number; bookedSeats: number; totalSeats: number }
interface TheatreRow { theatreId: string; theatreName: string; city: string; bookings: number; tickets: number; revenueMinor: number; occupancyPct: number }
interface Dist { status: string; count: number }

export interface TheatreOption { id: string; name: string }

export function ReportsView({ scope, theatres }: { scope: 'manager' | 'admin'; theatres: TheatreOption[] }) {
  const [range, setRange] = useState<Range>('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [theatreId, setTheatreId] = useState('');
  const base = `/api/${scope}/reports`;
  const customReady = range !== 'custom' || (from && to && from <= to);
  const params = qs({ range, from: range === 'custom' ? from : undefined, to: range === 'custom' ? to : undefined, theatreId });
  const opts = { enabled: Boolean(customReady), staleTime: 15_000 } as const;

  const summary = useQuery({ queryKey: [scope, 'summary', params], queryFn: () => api.get<Summary>(`${base}/summary${params}`), ...opts });
  const revenue = useQuery({ queryKey: [scope, 'revenue', params], queryFn: () => api.get<{ series: Series[] }>(`${base}/revenue${params}`), ...opts });
  const bookings = useQuery({ queryKey: [scope, 'bookings', params], queryFn: () => api.get<{ byMovie: ByMovie[] }>(`${base}/bookings${params}`), ...opts });
  const occupancy = useQuery({ queryKey: [scope, 'occupancy', params], queryFn: () => api.get<{ shows: ShowOcc[] }>(`${base}/occupancy${params}`), enabled: scope === 'manager' && Boolean(customReady), staleTime: 15_000 });
  const breakdown = useQuery({ queryKey: [scope, 'theatres', params], queryFn: () => api.get<{ theatres: TheatreRow[]; statusDistribution: Dist[]; paymentDistribution: Dist[] }>(`${base}/theatres${params}`), enabled: scope === 'admin' && Boolean(customReady), staleTime: 15_000 });

  const err = summary.error ?? revenue.error ?? bookings.error;
  const series = revenue.data?.series ?? [];
  const half = Math.floor(series.length / 2);
  const sum = (a: Series[]) => a.reduce((s, d) => s + d.bookings, 0);
  const prev = sum(series.slice(0, half));
  const recent = sum(series.slice(half));
  const trend = series.length < 2 ? '—' : prev === 0 ? (recent > 0 ? 'New' : '0%') : `${recent >= prev ? '+' : ''}${Math.round(((recent - prev) / prev) * 100)}%`;
  const s = summary.data;
  const noSeries = series.every((d) => d.bookings === 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Date range" className="flex gap-1 rounded-xl bg-raised p-1 text-sm">
          {([['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['custom', 'Custom']] as const).map(([k, l]) => (
            <button key={k} aria-pressed={range === k} onClick={() => setRange(k)} className={`rounded-lg px-3 py-1.5 transition ${range === k ? 'bg-brand text-white' : 'text-muted hover:text-ink'}`}>{l}</button>
          ))}
        </div>
        {range === 'custom' && (
          <>
            <label className="text-xs text-muted">From <input type="date" className="input ml-1 w-auto" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="text-xs text-muted">To <input type="date" className="input ml-1 w-auto" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
          </>
        )}
        <label className="text-xs text-muted">Theatre
          <select className="input ml-2 inline-block w-auto" value={theatreId} onChange={(e) => setTheatreId(e.target.value)} aria-label="Theatre">
            <option value="">{scope === 'manager' ? 'All my theatres' : 'All theatres'}</option>
            {theatres.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {!customReady && <p className="text-xs text-warn">Pick a valid from/to date range.</p>}
      </div>

      {err && <ErrorState message={errorMessage(err)} onRetry={() => void summary.refetch()} />}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {summary.isLoading ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />) : s && (
          scope === 'manager' ? (
            <>
              <Kpi label="Total bookings" value={s.bookings} />
              <Kpi label="Tickets sold" value={s.tickets} />
              <Kpi label="Gross revenue" value={formatMoney(s.revenueMinor)} tone="brand" />
              <Kpi label="Avg occupancy" value={`${s.avgOccupancyPct}%`} hint="Shows in range" />
              <Kpi label="Active / upcoming shows" value={s.activeShows} />
              <Kpi label="Booking trend" value={trend} hint="Second half vs first half" />
            </>
          ) : (
            <>
              <Kpi label="Customers" value={s.customers ?? 0} />
              <Kpi label="Theatre managers" value={s.managers ?? 0} />
              <Kpi label="Approved theatres" value={s.approvedTheatres ?? 0} />
              <Kpi label="Pending manager approvals" value={s.pendingManagers ?? 0} tone={s.pendingManagers ? 'warn' : undefined} />
              <Kpi label="Pending theatre approvals" value={s.pendingTheatres ?? 0} tone={s.pendingTheatres ? 'warn' : undefined} />
              <Kpi label="Confirmed bookings" value={s.bookings} />
              <Kpi label="Tickets sold" value={s.tickets} />
              <Kpi label="Gross ticket revenue" value={formatMoney(s.revenueMinor)} tone="brand" />
            </>
          )
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title={scope === 'admin' ? 'Revenue trend' : 'Daily revenue'} subtitle="Confirmed mock payments, INR, by IST day" empty={!revenue.isLoading && noSeries}
          table={{ headers: ['Day', 'Revenue'], rows: series.map((d) => [d.day, formatMoney(d.revenueMinor)]) }}>
          <DailyRevenueBars data={series} />
        </ChartCard>
        <ChartCard title={scope === 'admin' ? 'Booking trend' : 'Daily booking trend'} subtitle="Confirmed bookings per day" empty={!revenue.isLoading && noSeries}
          table={{ headers: ['Day', 'Bookings', 'Tickets'], rows: series.map((d) => [d.day, d.bookings, d.tickets]) }}>
          <BookingTrendLine data={series as unknown as Record<string, string | number>[]} />
        </ChartCard>
        <ChartCard title={scope === 'admin' ? 'Top-performing movies' : 'Bookings by movie'} subtitle="Tickets sold" empty={!bookings.isLoading && (bookings.data?.byMovie.length ?? 0) === 0}
          table={{ headers: ['Movie', 'Tickets', 'Revenue'], rows: (bookings.data?.byMovie ?? []).map((m) => [m.movieTitle, m.tickets, formatMoney(m.revenueMinor)]) }}>
          <RankedBars data={(bookings.data?.byMovie ?? []) as unknown as Record<string, string | number>[]} labelKey="movieTitle" valueKey="tickets" name="Tickets" axisLabel="Tickets sold" />
        </ChartCard>
        {scope === 'manager' && (
          <ChartCard title="Seat occupancy by show" subtitle="Booked seats as % of capacity" empty={!occupancy.isLoading && (occupancy.data?.shows.length ?? 0) === 0}
            table={{ headers: ['Show', 'Theatre', 'Occupancy'], rows: (occupancy.data?.shows ?? []).map((x) => [`${x.movieTitle} ${formatTime(x.startTime)}`, x.theatreName, `${x.occupancyPct}%`]) }}>
            <RankedBars data={(occupancy.data?.shows.slice(0, 12) ?? []).map((x) => ({ label: `${x.movieTitle} · ${formatTime(x.startTime)}`, pct: x.occupancyPct })) as Record<string, string | number>[]} labelKey="label" valueKey="pct" name="Occupancy" unit="%" color="#c98500" axisLabel="Occupancy (%)" />
          </ChartCard>
        )}
        {scope === 'admin' && breakdown.data && (
          <>
            <ChartCard title="Top-performing theatres" subtitle="Gross revenue (INR)" empty={breakdown.data.theatres.every((t) => t.revenueMinor === 0)}
              table={{ headers: ['Theatre', 'Revenue', 'Tickets'], rows: breakdown.data.theatres.map((t) => [t.theatreName, formatMoney(t.revenueMinor), t.tickets]) }}>
              <RankedBars data={breakdown.data.theatres as unknown as Record<string, string | number>[]} labelKey="theatreName" valueKey="revenueMinor" name="Revenue" money color="#3987e5" axisLabel="Revenue (INR)" />
            </ChartCard>
            <ChartCard title="Theatre occupancy comparison" subtitle="Average occupancy of shows in range" empty={breakdown.data.theatres.every((t) => t.occupancyPct === 0)}
              table={{ headers: ['Theatre', 'Occupancy'], rows: breakdown.data.theatres.map((t) => [t.theatreName, `${t.occupancyPct}%`]) }}>
              <RankedBars data={breakdown.data.theatres as unknown as Record<string, string | number>[]} labelKey="theatreName" valueKey="occupancyPct" name="Occupancy" unit="%" color="#c98500" axisLabel="Average occupancy (%)" />
            </ChartCard>
            <ChartCard title="Booking status" subtitle="All bookings created in range" empty={breakdown.data.statusDistribution.length === 0}
              table={{ headers: ['Status', 'Count'], rows: breakdown.data.statusDistribution.map((d) => [d.status, d.count]) }}>
              <DonutChart data={breakdown.data.statusDistribution as unknown as Record<string, string | number>[]} nameKey="status" valueKey="count" />
            </ChartCard>
            <ChartCard title="Payment status" subtitle="Mock payment attempts in range" empty={breakdown.data.paymentDistribution.length === 0}
              table={{ headers: ['Status', 'Count'], rows: breakdown.data.paymentDistribution.map((d) => [d.status, d.count]) }}>
              <DonutChart data={breakdown.data.paymentDistribution as unknown as Record<string, string | number>[]} nameKey="status" valueKey="count" />
            </ChartCard>
          </>
        )}
      </div>
      {scope === 'admin' && <div className="text-right"><Button variant="ghost" size="sm" onClick={() => { void summary.refetch(); void breakdown.refetch(); }}>Refresh</Button></div>}
    </div>
  );
}
