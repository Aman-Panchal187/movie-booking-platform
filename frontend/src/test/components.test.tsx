import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequireAuth } from '../components/common';
import { ChartCard } from '../components/charts';
import { Countdown } from '../components/Countdown';
import { MovieCard } from '../components/MovieCard';
import { Seat, SeatMap } from '../components/SeatMap';
import { ConfirmDialog } from '../components/ui';
import * as authModule from '../lib/auth';
import { formatMoney, mmss } from '../lib/format';
import { LoginPage, PendingApprovalPage, RegisterPage } from '../pages/AuthPages';

const seat = (n: number, status: Seat['status'] = 'AVAILABLE', type: Seat['seatType'] = 'STANDARD'): Seat => ({
  showSeatId: `s${n}`, row: 'A', number: n, seatType: type, priceMinor: 25000, status,
});

function wrap(ui: React.ReactNode, route = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter></QueryClientProvider>);
}

function mockAuth(user: Partial<authModule.User> | null, extra: Partial<ReturnType<typeof authModule.useAuth>> = {}) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({
    user: user ? ({ id: '1', name: 'Test User', email: 't@e.co', role: 'CUSTOMER', accountStatus: 'ACTIVE', rejectionReason: null, ...user } as authModule.User) : null,
    loading: false, login: vi.fn(), register: vi.fn(), logout: vi.fn(), refresh: vi.fn(), ...extra,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('formatting', () => {
  it('formats INR from minor units and mm:ss', () => {
    expect(formatMoney(25000)).toBe('₹250');
    expect(formatMoney(123456)).toContain('1,234.56');
    expect(mmss(125)).toBe('02:05');
    expect(mmss(-4)).toBe('00:00');
  });
});

describe('SeatMap', () => {
  it('renders distinct states and only lets available seats be chosen', async () => {
    const onToggle = vi.fn();
    render(<SeatMap seats={[seat(1), seat(2, 'HELD'), seat(3, 'BOOKED'), seat(4, 'AVAILABLE', 'PREMIUM')]} selected={new Set()} onToggle={onToggle} />);
    expect(screen.getByRole('button', { name: /seat 2.*held/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /seat 3.*booked/i })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /seat 1.*available/i }));
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ showSeatId: 's1' }));
    await userEvent.click(screen.getByRole('button', { name: /seat 3/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('marks selected seats with aria-pressed', () => {
    render(<SeatMap seats={[seat(1)]} selected={new Set(['s1'])} onToggle={() => undefined} />);
    expect(screen.getByRole('button', { name: /selected/i })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Countdown', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts down using the server clock and fires onExpire once', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    vi.setSystemTime(now);
    const onExpire = vi.fn();
    render(<Countdown expiresAt="2026-01-01T10:00:03Z" serverNow="2026-01-01T10:00:00Z" onExpire={onExpire} />);
    expect(screen.getByRole('timer')).toHaveTextContent('00:03');
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByRole('timer')).toHaveTextContent('00:01');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('timer')).toHaveTextContent('Hold expired');
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('ignores a skewed device clock by using the server-provided now', () => {
    vi.setSystemTime(new Date('2030-06-06T00:00:00Z')); // wildly wrong device clock
    render(<Countdown expiresAt="2026-01-01T10:05:00Z" serverNow="2026-01-01T10:00:00Z" />);
    expect(screen.getByRole('timer')).toHaveTextContent('05:00');
  });
});

describe('MovieCard', () => {
  it('links to the movie and shows its facts', () => {
    wrap(<MovieCard movie={{ id: 'm1', title: 'Midnight Orbit', description: '', language: 'English', genre: 'Sci-Fi', durationMinutes: 128, releaseDate: null, certification: 'UA', posterUrl: null, bannerUrl: null, trailerUrl: null, isActive: true, upcomingShows: 0 }} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/movies/m1');
    expect(screen.getByText('Sci-Fi · English')).toBeInTheDocument();
    expect(screen.getByText('2h 8m')).toBeInTheDocument();
    expect(screen.getByText('No shows scheduled')).toBeInTheDocument();
  });
});

describe('auth forms', () => {
  it('registration validates before calling the API', async () => {
    const register = vi.fn();
    mockAuth(null, { register });
    wrap(<RegisterPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Enter your full name')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Full name'), 'Jane Doe');
    await userEvent.type(screen.getByLabelText('Email'), 'jane@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Passw0rd1');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'different1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it('manager registration tab changes the submit action and never offers a role field', async () => {
    mockAuth(null);
    wrap(<RegisterPage />);
    await userEvent.click(screen.getByRole('tab', { name: 'Theatre manager' }));
    expect(screen.getByRole('button', { name: 'Request manager access' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
  });

  it('login submits credentials', async () => {
    const login = vi.fn().mockResolvedValue({ role: 'CUSTOMER', accountStatus: 'ACTIVE' });
    mockAuth(null, { login });
    wrap(<LoginPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(login).toHaveBeenCalledWith('a@b.co', 'secret');
  });
});

describe('route guards', () => {
  const routes = (
    <Routes>
      <Route element={<RequireAuth roles={['ADMIN']} />}><Route path="/admin" element={<p>admin area</p>} /></Route>
      <Route element={<RequireAuth roles={['THEATRE_MANAGER']} />}><Route path="/manager" element={<p>manager area</p>} /></Route>
      <Route path="/login" element={<p>login page</p>} />
      <Route path="/forbidden" element={<p>forbidden page</p>} />
      <Route path="/manager/pending" element={<p>pending page</p>} />
    </Routes>
  );

  it('sends anonymous users to login', () => {
    mockAuth(null);
    wrap(routes, '/admin');
    expect(screen.getByText('login page')).toBeInTheDocument();
  });
  it('blocks the wrong role', () => {
    mockAuth({ role: 'CUSTOMER' });
    wrap(routes, '/admin');
    expect(screen.getByText('forbidden page')).toBeInTheDocument();
  });
  it('keeps unapproved managers on the pending page', () => {
    mockAuth({ role: 'THEATRE_MANAGER', accountStatus: 'PENDING_APPROVAL' });
    wrap(routes, '/manager');
    expect(screen.getByText('pending page')).toBeInTheDocument();
  });
  it('lets approved managers in', () => {
    mockAuth({ role: 'THEATRE_MANAGER', accountStatus: 'ACTIVE' });
    wrap(routes, '/manager');
    expect(screen.getByText('manager area')).toBeInTheDocument();
  });
});

describe('PendingApprovalPage', () => {
  it('shows the awaiting state for a pending manager', async () => {
    mockAuth({ role: 'THEATRE_MANAGER', accountStatus: 'PENDING_APPROVAL' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { accountStatus: 'PENDING_APPROVAL', rejectionReason: null } }), { status: 200 }));
    wrap(<PendingApprovalPage />);
    expect(await screen.findByRole('heading', { name: 'Awaiting approval' })).toBeInTheDocument();
  });
  it('shows the rejection reason', async () => {
    mockAuth({ role: 'THEATRE_MANAGER', accountStatus: 'REJECTED' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: { accountStatus: 'REJECTED', rejectionReason: 'Incomplete details' } }), { status: 200 }));
    wrap(<PendingApprovalPage />);
    expect(await screen.findByText('Incomplete details')).toBeInTheDocument();
  });
});

describe('ConfirmDialog', () => {
  it('requires a reason before a rejection can be confirmed', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog open title="Reject?" message="msg" confirmLabel="Reject" tone="danger" reasonRequired onCancel={() => undefined} onConfirm={onConfirm} />);
    const button = screen.getByRole('button', { name: 'Reject' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/reason/i), 'Bad data');
    await userEvent.click(button);
    expect(onConfirm).toHaveBeenCalledWith('Bad data');
  });
});

describe('ChartCard', () => {
  it('shows an empty state instead of an empty chart', () => {
    render(<ChartCard title="Revenue" empty><div>chart</div></ChartCard>);
    expect(screen.getByText('No data for this period.')).toBeInTheDocument();
    expect(screen.queryByText('chart')).not.toBeInTheDocument();
  });
  it('offers an accessible table view of the same data', async () => {
    render(<ChartCard title="Revenue" empty={false} table={{ headers: ['Day', 'Revenue'], rows: [['10-01', '₹500']] }}><div>chart</div></ChartCard>);
    await userEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(screen.getByRole('cell', { name: '₹500' })).toBeInTheDocument();
  });
});
