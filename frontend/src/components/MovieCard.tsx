import { Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { duration } from '../lib/format';
import { SafeImage } from './common';

export interface Movie {
  id: string;
  title: string;
  description: string;
  language: string;
  genre: string;
  durationMinutes: number;
  releaseDate: string | null;
  certification: string;
  posterUrl: string | null;
  bannerUrl: string | null;
  trailerUrl: string | null;
  isActive: boolean;
  upcomingShows?: number;
}

export function MovieCard({ movie }: { movie: Movie }) {
  return (
    <Link to={`/movies/${movie.id}`} className="group block overflow-hidden rounded-2xl border border-line bg-surface transition hover:-translate-y-1 hover:border-brand/40 hover:shadow-glow">
      <div className="relative overflow-hidden">
        <SafeImage src={movie.posterUrl} alt={`${movie.title} poster`} className="w-full transition duration-500 group-hover:scale-105" />
        <span className="absolute left-3 top-3 rounded-md bg-black/70 px-2 py-0.5 text-xs font-medium backdrop-blur">{movie.certification}</span>
        {movie.upcomingShows === 0 && <span className="absolute bottom-3 left-3 rounded-md bg-black/70 px-2 py-0.5 text-xs text-muted">No shows scheduled</span>}
      </div>
      <div className="p-4">
        <h3 className="line-clamp-1 text-base font-semibold">{movie.title}</h3>
        <p className="mt-1 text-xs text-muted">{movie.genre} · {movie.language}</p>
        <p className="mt-2 flex items-center gap-1 text-xs text-muted"><Clock className="h-3 w-3" aria-hidden /> {duration(movie.durationMinutes)}</p>
      </div>
    </Link>
  );
}
