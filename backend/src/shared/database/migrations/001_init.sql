CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('CUSTOMER','THEATRE_MANAGER','ADMIN')),
  account_status TEXT NOT NULL CHECK (account_status IN ('PENDING_APPROVAL','ACTIVE','REJECTED','SUSPENDED')),
  rejection_reason TEXT,
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX users_email_unique ON users (LOWER(email));
CREATE INDEX users_role_status_idx ON users (role, account_status);

CREATE TABLE movies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL,
  genre TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  release_date DATE,
  certification TEXT NOT NULL DEFAULT 'U',
  poster_url TEXT,
  banner_url TEXT,
  trailer_url TEXT,
  external_media_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX movies_active_idx ON movies (is_active, title);

CREATE TABLE theatres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  address TEXT NOT NULL,
  contact_number TEXT NOT NULL,
  description TEXT,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('PENDING_APPROVAL','APPROVED','REJECTED','SUSPENDED')),
  submitted_by UUID NOT NULL REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX theatres_status_city_idx ON theatres (approval_status, city);
CREATE INDEX theatres_submitted_by_idx ON theatres (submitted_by);

CREATE TABLE theatre_manager_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_id UUID NOT NULL REFERENCES users(id),
  theatre_id UUID NOT NULL REFERENCES theatres(id),
  assigned_by UUID NOT NULL REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manager_id, theatre_id)
);
CREATE INDEX tma_theatre_idx ON theatre_manager_assignments (theatre_id);

CREATE TABLE screens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  theatre_id UUID NOT NULL REFERENCES theatres(id),
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (theatre_id, name)
);

CREATE TABLE seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  screen_id UUID NOT NULL REFERENCES screens(id),
  row_label TEXT NOT NULL,
  seat_number INTEGER NOT NULL CHECK (seat_number > 0),
  seat_type TEXT NOT NULL CHECK (seat_type IN ('STANDARD','PREMIUM','RECLINER')),
  UNIQUE (screen_id, row_label, seat_number)
);

CREATE TABLE shows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movie_id UUID NOT NULL REFERENCES movies(id),
  screen_id UUID NOT NULL REFERENCES screens(id),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED','CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_time > start_time),
  CONSTRAINT shows_no_overlap EXCLUDE USING gist (
    screen_id WITH =, tstzrange(start_time, end_time) WITH &&
  ) WHERE (status = 'SCHEDULED')
);
CREATE INDEX shows_start_idx ON shows (start_time) WHERE status = 'SCHEDULED';
CREATE INDEX shows_movie_idx ON shows (movie_id, start_time);

CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  show_id UUID NOT NULL REFERENCES shows(id),
  booking_reference TEXT NOT NULL UNIQUE,
  total_amount_minor BIGINT NOT NULL CHECK (total_amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL CHECK (status IN ('HELD','PAYMENT_PROCESSING','CONFIRMED','EXPIRED','CANCELLED')),
  hold_expires_at TIMESTAMPTZ NOT NULL,
  payment_processing_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC);
CREATE INDEX bookings_show_status_idx ON bookings (show_id, status);

CREATE TABLE show_seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id UUID NOT NULL REFERENCES shows(id),
  seat_id UUID NOT NULL REFERENCES seats(id),
  price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
  status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE','HELD','BOOKED')),
  hold_token UUID,
  hold_expires_at TIMESTAMPTZ,
  booking_id UUID REFERENCES bookings(id),
  UNIQUE (show_id, seat_id),
  CHECK ((status = 'AVAILABLE' AND booking_id IS NULL AND hold_token IS NULL)
      OR (status <> 'AVAILABLE' AND booking_id IS NOT NULL))
);
CREATE INDEX show_seats_show_status_idx ON show_seats (show_id, status);
CREATE INDEX show_seats_booking_idx ON show_seats (booking_id);

CREATE TABLE booking_seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  show_seat_id UUID NOT NULL REFERENCES show_seats(id),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  UNIQUE (booking_id, show_seat_id)
);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  user_id UUID NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL CHECK (status IN ('PROCESSING','SUCCESS','FAILED')),
  transaction_reference TEXT,
  response_status INTEGER,
  response_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_key)
);
CREATE UNIQUE INDEX payments_one_success_per_booking ON payments (booking_id) WHERE status = 'SUCCESS';
CREATE INDEX payments_status_created_idx ON payments (status, created_at);

CREATE TABLE tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL UNIQUE REFERENCES bookings(id),
  ticket_number TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE approval_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_entity_idx ON approval_audit_logs (entity_type, entity_id);
CREATE INDEX audit_created_idx ON approval_audit_logs (created_at DESC);
