-- Client-side error reports (fallback telemetry when no Sentry DSN is set).
-- Deliberately minimal: insert-only for clients, no reads, no FK on room_code
-- (a report must never fail because its room was pruned or mistyped).
create table if not exists client_errors (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  stack text,
  source text,
  url text,
  room_code text,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table client_errors enable row level security;

-- Clients may report, never read (service role / dashboard bypass RLS).
revoke all on client_errors from anon, authenticated;
grant insert on client_errors to anon, authenticated;

drop policy if exists "report client errors" on client_errors;
create policy "report client errors"
  on client_errors for insert
  to anon, authenticated
  with check (true);

create index if not exists client_errors_created_at_idx
  on client_errors (created_at desc);
