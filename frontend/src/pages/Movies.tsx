import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Movie } from '../components/MovieCard';
import { EmptyState, ErrorState, PageHeader, SearchBox } from '../components/ui';
import { api, errorMessage, qs } from '../lib/api';
import { MovieGrid, MovieGridSkeleton } from './Home';

const GENRES = ['Sci-Fi', 'Drama', 'Thriller', 'Animation', 'Comedy', 'Action'];
const LANGUAGES = ['English', 'Hindi', 'Tamil', 'Telugu'];

export function MoviesPage() {
  const [filters, setFilters] = useState({ q: '', genre: '', language: '', city: '' });
  const set = (k: keyof typeof filters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['movies', filters],
    queryFn: () => api.get<Movie[]>(`/api/movies${qs(filters)}`),
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <PageHeader title="Movies" subtitle="Filter by genre, language or city." />
      <div className="mb-8 flex flex-wrap items-center gap-3">
        <SearchBox value={filters.q} onChange={set('q')} placeholder="Search by title" />
        <select aria-label="Genre" className="input w-auto" value={filters.genre} onChange={(e) => set('genre')(e.target.value)}>
          <option value="">All genres</option>{GENRES.map((g) => <option key={g}>{g}</option>)}
        </select>
        <select aria-label="Language" className="input w-auto" value={filters.language} onChange={(e) => set('language')(e.target.value)}>
          <option value="">All languages</option>{LANGUAGES.map((g) => <option key={g}>{g}</option>)}
        </select>
        <SearchBox value={filters.city} onChange={set('city')} placeholder="City (e.g. Mumbai)" />
      </div>
      {isLoading && <MovieGridSkeleton />}
      {error && <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />}
      {data && data.length === 0 && <EmptyState title="No movies match" text="Try clearing a filter." />}
      {data && data.length > 0 && <MovieGrid movies={data} />}
    </div>
  );
}
