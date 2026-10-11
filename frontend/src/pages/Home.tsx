import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Clock, Star } from 'lucide-react';
import { Link } from 'react-router-dom';
import { SafeImage } from '../components/common';
import { Movie, MovieCard } from '../components/MovieCard';
import { Button, EmptyState, ErrorState, Skeleton } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { duration } from '../lib/format';

export function MovieGrid({ movies }: { movies: Movie[] }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 lg:gap-6">
      {movies.map((m) => <MovieCard key={m.id} movie={m} />)}
    </div>
  );
}

export function MovieGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 lg:gap-6" aria-busy="true">
      {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="aspect-[2/3]" />)}
    </div>
  );
}

export function HomePage() {
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['movies', {}], queryFn: () => api.get<Movie[]>('/api/movies') });
  const featured = data?.find((m) => (m.upcomingShows ?? 0) > 0 && m.bannerUrl) ?? data?.[0];

  return (
    <>
      <section className="relative isolate overflow-hidden border-b border-line">
        {featured && <SafeImage src={featured.bannerUrl} alt="" ratio="banner" className="absolute inset-0 -z-10 h-full w-full opacity-40" />}
        <div className="absolute inset-0 -z-10 bg-gradient-to-t from-bg via-bg/70 to-bg/30" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-bg via-bg/50 to-transparent" />
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:py-32">
          {isLoading ? <Skeleton className="h-48 max-w-xl" /> : featured ? (
            <div className="max-w-xl">
              <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-xs font-medium text-brand"><Star className="h-3 w-3 fill-current" aria-hidden /> Now showing</p>
              <h1 className="text-4xl font-bold sm:text-6xl">{featured.title}</h1>
              <p className="mt-3 flex items-center gap-3 text-sm text-muted">
                <span>{featured.genre}</span><span aria-hidden>·</span><span>{featured.language}</span><span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{duration(featured.durationMinutes)}</span>
              </p>
              <p className="mt-4 line-clamp-3 text-base text-muted">{featured.description}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to={`/movies/${featured.id}`}><Button size="lg">Book tickets <ArrowRight className="h-4 w-4" aria-hidden /></Button></Link>
                <Link to="/movies"><Button size="lg" variant="secondary">Browse all</Button></Link>
              </div>
            </div>
          ) : (
            <div className="max-w-xl"><h1 className="text-4xl font-bold sm:text-6xl">Your seat is waiting.</h1><p className="mt-3 text-muted">Pick a movie, choose your seats, done.</p></div>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="mb-6 flex items-end justify-between">
          <h2 className="text-2xl font-semibold">Now showing</h2>
          <Link to="/movies" className="text-sm text-brand hover:underline">See all</Link>
        </div>
        {isLoading && <MovieGridSkeleton />}
        {error && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}
        {data && data.length === 0 && <EmptyState title="No movies yet" text="Check back soon." />}
        {data && data.length > 0 && <MovieGrid movies={data} />}
      </section>
    </>
  );
}
