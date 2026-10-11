import clsx from 'clsx';
import { Timer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { mmss } from '../lib/format';

interface Props {
  /** ISO time the hold ends (database clock). */
  expiresAt: string;
  /** Database "now" returned with the booking, so a skewed device clock cannot extend or cut the timer. */
  serverNow: string;
  onExpire?: () => void;
}

export function Countdown({ expiresAt, serverNow, onExpire }: Props) {
  const offset = useRef(new Date(serverNow).getTime() - Date.now());
  const compute = () => Math.max(0, Math.round((new Date(expiresAt).getTime() - (Date.now() + offset.current)) / 1000));
  const [left, setLeft] = useState(compute);
  const fired = useRef(false);

  useEffect(() => {
    offset.current = new Date(serverNow).getTime() - Date.now();
    fired.current = false;
    setLeft(compute());
    const id = setInterval(() => {
      const next = compute();
      setLeft(next);
      if (next <= 0 && !fired.current) {
        fired.current = true;
        onExpire?.();
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiresAt, serverNow]);

  const urgent = left <= 60;
  return (
    <div role="timer" aria-live="off" aria-label={`Seats held for ${mmss(left)}`} className={clsx('inline-flex items-center gap-2 rounded-full border px-4 py-2 font-mono text-sm', urgent ? 'border-bad/40 bg-bad/10 text-bad' : 'border-line bg-raised text-ink')}>
      <Timer className="h-4 w-4" aria-hidden />
      <span>{left > 0 ? `Seats held ${mmss(left)}` : 'Hold expired'}</span>
    </div>
  );
}
