import { BarChart3, Building2, ClipboardCheck, Film, History, LayoutDashboard, Receipt, UserCheck, Users } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { ColdStartBanner, ErrorBoundary, RequireAuth } from './components/common';
import { CustomerLayout } from './components/CustomerLayout';
import { DashboardLayout, NavItem } from './components/DashboardLayout';
import { ForbiddenPage, LoginPage, NotFoundPage, PendingApprovalPage, RegisterPage } from './pages/AuthPages';
import { CheckoutPage, MyBookingsPage, SeatSelectionPage, TicketPage } from './pages/Booking';
import { HomePage } from './pages/Home';
import { MovieDetailPage } from './pages/MovieDetail';
import { MoviesPage } from './pages/Movies';
import { Spinner } from './components/ui';

// Dashboards (charts, tables, forms) are only downloaded by the roles that use them.
const named = <T extends Record<string, unknown>, K extends keyof T>(load: () => Promise<T>, key: K) =>
  lazy(async () => ({ default: (await load())[key] as React.ComponentType }));
const admin = () => import('./pages/admin/AdminPages');
const manager = () => import('./pages/manager/ManagerPages');
const AdminOverviewPage = named(admin, 'AdminOverviewPage');
const ManagerApprovalsPage = named(admin, 'ManagerApprovalsPage');
const TheatreApprovalsPage = named(admin, 'TheatreApprovalsPage');
const UsersPage = named(admin, 'UsersPage');
const AdminMoviesPage = named(admin, 'AdminMoviesPage');
const BookingsPaymentsPage = named(admin, 'BookingsPaymentsPage');
const AuditLogsPage = named(admin, 'AuditLogsPage');
const ManagerOverviewPage = named(manager, 'ManagerOverviewPage');
const ManagerTheatresPage = named(manager, 'ManagerTheatresPage');
const NewTheatrePage = named(manager, 'NewTheatrePage');
const ManagerTheatreDetailPage = named(manager, 'ManagerTheatreDetailPage');

const MANAGER_NAV: NavItem[] = [
  { to: '/manager', label: 'Overview & reports', icon: LayoutDashboard, end: true },
  { to: '/manager/theatres', label: 'My theatres', icon: Building2 },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin', label: 'Overview & reports', icon: BarChart3, end: true },
  { to: '/admin/managers', label: 'Manager approvals', icon: UserCheck },
  { to: '/admin/theatres', label: 'Theatre approvals', icon: ClipboardCheck },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/movies', label: 'Movies', icon: Film },
  { to: '/admin/bookings', label: 'Bookings & payments', icon: Receipt },
  { to: '/admin/audit', label: 'Audit log', icon: History },
];

export function App() {
  return (
    <ErrorBoundary>
      <ColdStartBanner />
      <Suspense fallback={<Spinner />}>
      <Routes>
        <Route element={<CustomerLayout />}>
          <Route index element={<HomePage />} />
          <Route path="movies" element={<MoviesPage />} />
          <Route path="movies/:id" element={<MovieDetailPage />} />
          <Route path="shows/:showId" element={<SeatSelectionPage />} />
          <Route element={<RequireAuth roles={['CUSTOMER', 'ADMIN']} />}>
            <Route path="checkout/:bookingId" element={<CheckoutPage />} />
            <Route path="tickets/:id" element={<TicketPage />} />
            <Route path="bookings" element={<MyBookingsPage />} />
          </Route>
        </Route>

        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="forbidden" element={<ForbiddenPage />} />
        <Route element={<RequireAuth roles={['THEATRE_MANAGER']} allowPending />}>
          <Route path="manager/pending" element={<PendingApprovalPage />} />
        </Route>

        <Route element={<RequireAuth roles={['THEATRE_MANAGER']} />}>
          <Route path="manager" element={<DashboardLayout items={MANAGER_NAV} area="Theatre manager" />}>
            <Route index element={<ManagerOverviewPage />} />
            <Route path="theatres" element={<ManagerTheatresPage />} />
            <Route path="theatres/new" element={<NewTheatrePage />} />
            <Route path="theatres/:id" element={<ManagerTheatreDetailPage />} />
          </Route>
        </Route>

        <Route element={<RequireAuth roles={['ADMIN']} />}>
          <Route path="admin" element={<DashboardLayout items={ADMIN_NAV} area="Administrator" />}>
            <Route index element={<AdminOverviewPage />} />
            <Route path="managers" element={<ManagerApprovalsPage />} />
            <Route path="theatres" element={<TheatreApprovalsPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="movies" element={<AdminMoviesPage />} />
            <Route path="bookings" element={<BookingsPaymentsPage />} />
            <Route path="audit" element={<AuditLogsPage />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}
