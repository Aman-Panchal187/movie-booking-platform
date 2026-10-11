import clsx from 'clsx';
import { formatMoney } from '../lib/format';

export interface Seat {
  showSeatId: string;
  row: string;
  number: number;
  seatType: 'STANDARD' | 'PREMIUM' | 'RECLINER';
  priceMinor: number;
  status: 'AVAILABLE' | 'HELD' | 'BOOKED';
}

interface Props {
  seats: Seat[];
  selected: Set<string>;
  onToggle: (seat: Seat) => void;
  disabled?: boolean;
}

const TYPE_RING: Record<Seat['seatType'], string> = {
  STANDARD: 'border-line',
  PREMIUM: 'border-info/60',
  RECLINER: 'border-warn/70',
};

export function SeatMap({ seats, selected, onToggle, disabled }: Props) {
  const rows = new Map<string, Seat[]>();
  seats.forEach((s) => rows.set(s.row, [...(rows.get(s.row) ?? []), s]));

  return (
    <div>
      <div className="mx-auto mb-8 max-w-xl" aria-hidden>
        <div className="h-1.5 rounded-full bg-gradient-to-r from-transparent via-brand to-transparent shadow-glow" />
        <p className="mt-2 text-center text-[11px] uppercase tracking-[0.3em] text-muted">Screen this way</p>
      </div>

      <div className="overflow-x-auto pb-2">
        <div role="group" aria-label="Seat map" className="mx-auto flex w-max min-w-full flex-col items-center gap-1.5 px-2">
          {[...rows.entries()].map(([row, rowSeats]) => (
            <div key={row} className="flex items-center gap-1.5">
              <span className="w-5 text-center text-xs text-muted" aria-hidden>{row}</span>
              {rowSeats.map((seat) => {
                const isSelected = selected.has(seat.showSeatId);
                const unavailable = seat.status !== 'AVAILABLE';
                const label = `Row ${seat.row} seat ${seat.number}, ${seat.seatType.toLowerCase()}, ${formatMoney(seat.priceMinor)}, ${isSelected ? 'selected' : seat.status.toLowerCase()}`;
                return (
                  <button
                    key={seat.showSeatId}
                    type="button"
                    aria-label={label}
                    aria-pressed={isSelected}
                    disabled={disabled || unavailable}
                    title={`${seat.row}${seat.number} · ${formatMoney(seat.priceMinor)}`}
                    onClick={() => onToggle(seat)}
                    className={clsx(
                      'h-7 w-7 rounded-md border text-[10px] font-medium transition sm:h-8 sm:w-8 sm:text-xs',
                      isSelected && 'scale-105 border-brand bg-brand text-white shadow-glow',
                      !isSelected && seat.status === 'AVAILABLE' && ['bg-raised text-muted hover:border-brand/60 hover:text-ink', TYPE_RING[seat.seatType]],
                      seat.status === 'HELD' && 'cursor-not-allowed border-warn/40 bg-warn/10 text-warn/70 [background-image:repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(251,191,36,.18)_3px,rgba(251,191,36,.18)_5px)]',
                      seat.status === 'BOOKED' && 'cursor-not-allowed border-transparent bg-line/40 text-muted/40 line-through',
                    )}
                  >
                    {seat.number}
                  </button>
                );
              })}
              <span className="w-5 text-center text-xs text-muted" aria-hidden>{row}</span>
            </div>
          ))}
        </div>
      </div>

      <ul className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted" aria-label="Seat legend">
        <Legend swatch="bg-raised border-line" label="Available" />
        <Legend swatch="bg-brand border-brand" label="Selected" />
        <Legend swatch="bg-warn/10 border-warn/40 [background-image:repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(251,191,36,.18)_3px,rgba(251,191,36,.18)_5px)]" label="Held by someone" />
        <Legend swatch="bg-line/40 border-transparent" label="Booked" />
        <Legend swatch="bg-raised border-info/60" label="Premium" />
        <Legend swatch="bg-raised border-warn/70" label="Recliner" />
      </ul>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={clsx('h-4 w-4 rounded border', swatch)} aria-hidden /> {label}
    </li>
  );
}
