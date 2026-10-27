-- Applied 2026-10-27. Owner account gets unlimited AI use: consume/refund skip the balance for allow-listed users.
create table if not exists public.unlimited_users (user_id uuid primary key references auth.users(id) on delete cascade, note text, created_at timestamptz not null default now());
alter table public.unlimited_users enable row level security; -- no policies: readable only by the SECURITY DEFINER functions and the service role
-- consume_credit / refund_credit: return the current balance untouched when the user is in unlimited_users (see the live definitions).
-- insert into public.unlimited_users (user_id, note) select id, 'owner' from auth.users where lower(email) = 'jamie@corby.associates' on conflict do nothing;
