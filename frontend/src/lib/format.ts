/** Money is integer minor units (paise); always displayed as INR. */
export function formatMoney(minor: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
}

const TZ = 'Asia/Kolkata';

export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const formatTime = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

export const formatDay = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));

export const formatLongDate = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** Business date (IST) of an ISO instant as YYYY-MM-DD. */
export const istDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

export const duration = (min: number) => `${Math.floor(min / 60)}h ${min % 60}m`;

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
