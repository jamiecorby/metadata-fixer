-- Metadata Fixer: accounts, credits, usage. No images are ever stored.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  credits integer not null default 0 check (credits >= 0),
  created_at timestamptz not null default now()
);
create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  reason text not null,
  ref text unique,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx on public.credit_ledger(user_id, created_at desc);
create table if not exists public.ai_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ok boolean not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  ms integer,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists ai_requests_user_idx on public.ai_requests(user_id, created_at desc);
create table if not exists public.user_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key in ('templates','last')),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key),
  constraint user_settings_size check (pg_column_size(value) < 200000)
);

alter table public.profiles enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.ai_requests enable row level security;
alter table public.user_settings enable row level security;

create policy "own profile read" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "own ledger read" on public.credit_ledger for select to authenticated using ((select auth.uid()) = user_id);
create policy "own usage read" on public.ai_requests for select to authenticated using ((select auth.uid()) = user_id);
create policy "own settings read" on public.user_settings for select to authenticated using ((select auth.uid()) = user_id);
create policy "own settings insert" on public.user_settings for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own settings update" on public.user_settings for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own settings delete" on public.user_settings for delete to authenticated using ((select auth.uid()) = user_id);

-- Starter credits on sign-up
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, credits) values (new.id, 25) on conflict (id) do nothing;
  insert into public.credit_ledger (user_id, delta, reason, ref) values (new.id, 25, 'starter', 'starter:' || new.id) on conflict (ref) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Atomic credit operations (service role only)
create or replace function public.consume_credit(p_user uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare left_ integer;
begin
  update public.profiles set credits = credits - 1 where id = p_user and credits > 0 returning credits into left_;
  if left_ is null then return -1; end if;
  insert into public.credit_ledger (user_id, delta, reason) values (p_user, -1, 'ai_suggestion');
  return left_;
end $$;
create or replace function public.refund_credit(p_user uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare left_ integer;
begin
  update public.profiles set credits = credits + 1 where id = p_user returning credits into left_;
  insert into public.credit_ledger (user_id, delta, reason) values (p_user, 1, 'refund_failed_ai');
  return left_;
end $$;
create or replace function public.add_credits(p_user uuid, p_n integer, p_reason text, p_ref text) returns integer
language plpgsql security definer set search_path = '' as $$
declare left_ integer;
begin
  if p_n <= 0 then raise exception 'bad amount'; end if;
  begin
    insert into public.credit_ledger (user_id, delta, reason, ref) values (p_user, p_n, p_reason, p_ref);
  exception when unique_violation then
    select credits into left_ from public.profiles where id = p_user; return left_; -- already applied (idempotent)
  end;
  insert into public.profiles (id, credits) values (p_user, p_n)
    on conflict (id) do update set credits = public.profiles.credits + excluded.credits
    returning credits into left_;
  return left_;
end $$;
revoke all on function public.consume_credit(uuid) from public, anon, authenticated;
revoke all on function public.refund_credit(uuid) from public, anon, authenticated;
revoke all on function public.add_credits(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
