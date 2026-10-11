import { useQuery } from '@tanstack/react-query';
import { Clock, MapPin } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { SafeImage, TrailerPlayer } from '../components/common';
import { Movie } from '../components/MovieCard';
import { Badge, EmptyState, ErrorState, Skeleton } from '../components/ui';
import { api, errorMessage, qs } from '../lib/api';
import { duration, formatDay, formatMoney, formatTime, istDate } from '../lib/format';

export interface ShowSummary {
  id: string;
  startTime: string;
  movieId: string;
  theatreId: string;
  theatreName: string;
  city: string;
  screenName: string;
  minPriceMinor: number;
  availableSeats: number;
  totalSeats: number;
}

export function MovieDetailPage() {
  const { id = '' } = useParams();
  const [city, setCity] = useState('');
  const [day, setDay] = useState('');

  const movie = useQuery({ queryKey: ['movie', id], queryFn: () => api.get<Movie>(`/api/movies/${id}`) });
  const shows = useQuery({ queryKey: ['shows', id, city], queryFn: () => api.get<ShowSummary[]>(`/api/shows${qs({ movieId: id, city })}`) });

  const days = useMemo(() => [...new Set((shows.data ?? []).map((s) => istDate(s.startTime)))], [shows.data]);
  const activeDay = day && days.includes(day) ? day : days[0];
  const byTheatre = useMemo(() => {
    const map = new Map<string, { name: string; city: string; shows: ShowSummary[] }>();
    (shows.data ?? []).filter((s) => istDate(s.startTime) === activeDay).forEach((s) => {
      const entry = map.get(s.theatreId) ?? { name: s.theatreName, city: s.city, shows: [] };
      entry.shows.push(s);
      map.set(s.theatreId, entry);
    });
    return [...map.entries()];
  }, [shows.data, activeDay]);
  const cities = useMemo(() => [...new Set((shows.data ?? []).map((s) => s.city))], [shows.data]);

  if (movie.isLoading) return <div className="mx-auto max-w-6xl space-y-4 px-4 py-10"><Skeleton className="h-72" /><Skeleton className="h-40" /></div>;
  if (movie.error || !movie.data) return <div className="mx-auto max-w-xl px-4 py-16"><ErrorState message={errorMessage(movie.error ?? new Error('Movie not found'))} /></div>;
  const m = movie.data;

  return (
    <div>
      <section className="relative isolate overflow-hidden border-b border-line">
        <SafeImage src={m.bannerUrl} alt="" ratio="banner" className="absolute inset-0 -z-10 h-full w-full opacity-25" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-bg to-bg/60" />
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[240px_1fr] md:py-14">
          <SafeImage src={m.posterUrl} alt={`${m.title} poster`} className="w-48 rounded-2xl border border-line shadow-2xl md:w-full" />
          <div>
            <div className="flex flex-wrap gap-2"><Badge tone="info">{m.certification}</Badge><Badge>{m.genre}</Badge><Badge>{m.language}</Badge></div>
            <h1 className="mt-3 text-3xl font-bold sm:text-5xl">{m.title}</h1>
            <p className="mt-2 flex items-center gap-1.5 text-sm text-muted"><Clock className="h-4 w-4" aria-hidden /> {duration(m.durationMinutes)}</p>
            <p className="mt-5 max-w-2xl text-muted">{m.description}</p>
            <div className="mt-6 max-w-xl"><TrailerPlayer url={m.trailerUrl} title={m.title} /></div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-semibold">Showtimes</h2>
          {cities.length > 1 || city ? (
            <select aria-label="City" className="input w-auto" value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="">All cities</option>{cities.map((c) => <option key={c}>{c}</option>)}
            </select>
          ) : null}
        </div>

        {shows.isLoading && <Skeleton className="h-40" />}
        {shows.error && <ErrorState message={errorMessage(shows.error)} onRetry={() => void shows.refetch()} />}
        {shows.data && days.length === 0 && <EmptyState title="No upcoming shows" text="This movie has no scheduled showtimes yet." />}

        {days.length > 0 && (
          <>
            <div role="tablist" aria-label="Date" className="mb-6 flex gap-2 overflow-x-auto pb-1">
              {days.map((d) => {
                const sample = shows.data!.find((s) => istDate(s.startTime) === d)!;
                return (
                  <button key={d} role="tab" aria-selected={d === activeDay} onClick={() => setDay(d)}
                    className={`shrink-0 rounded-xl border px-4 py-2 text-sm transition ${d === activeDay ? 'border-brand bg-brand-soft text-ink' : 'border-line text-muted hover:text-ink'}`}>
                    {formatDay(sample.startTime)}
                  </button>
                );
              })}
            </div>
            <div className="space-y-4">
              {byTheatre.map(([theatreId, t]) => (
                <div key={theatreId} className="card p-5">
                  <h3 className="text-lg font-semibold">{t.name}</h3>
                  <p className="mb-4 flex items-center gap-1 text-xs text-muted"><MapPin className="h-3 w-3" aria-hidden /> {t.city}</p>
                  <div className="flex flex-wrap gap-3">
                    {t.shows.map((s) => {
                      const soldOut = s.availableSeats === 0;
                      const content = (
                        <>
                          <span className="block text-base font-semibold">{formatTime(s.startTime)}</span>
                          <span className="block text-[11px] text-muted">{s.screenName} · from {formatMoney(s.minPriceMinor)}</span>
                          <span className={`block text-[11px] ${s.availableSeats < 10 ? 'text-warn' : 'text-ok'}`}>{soldOut ? 'Sold out' : `${s.availableSeats} left`}</span>
                        </>
                      );
                      return soldOut ? (
                        <div key={s.id} aria-disabled className="cursor-not-allowed rounded-xl border border-line px-4 py-2.5 text-center opacity-50">{content}</div>
                      ) : (
                        <Link key={s.id} to={`/shows/${s.id}`} className="rounded-xl border border-line bg-raised px-4 py-2.5 text-center transition hover:border-brand hover:shadow-glow">{content}</Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
