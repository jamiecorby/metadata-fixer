-- Starter credits once per real mailbox; credit removal for refunds and disputes.
create or replace function public.normalized_email(e text) returns text language sql immutable set search_path = '' as $$
  select case
    when split_part(lower(e), '@', 2) in ('gmail.com', 'googlemail.com')
      then replace(split_part(split_part(lower(e), '@', 1), '+', 1), '.', '') || '@gmail.com'
    else split_part(split_part(lower(e), '@', 1), '+', 1) || '@' || split_part(lower(e), '@', 2)
  end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare granted integer;
begin
  insert into public.credit_ledger (user_id, delta, reason, ref)
    values (new.id, 25, 'starter', 'starter:' || public.normalized_email(coalesce(new.email, new.id::text)))
    on conflict (ref) do nothing;
  get diagnostics granted = row_count;
  insert into public.profiles (id, credits) values (new.id, case when granted > 0 then 25 else 0 end) on conflict (id) do nothing;
  return new;
end $$;

create or replace function public.remove_credits(p_user uuid, p_n integer, p_reason text, p_ref text) returns integer
language plpgsql security definer set search_path = '' as $$
declare left_ integer;
begin
  if p_n <= 0 then raise exception 'bad amount'; end if;
  begin
    insert into public.credit_ledger (user_id, delta, reason, ref) values (p_user, -p_n, p_reason, p_ref);
  exception when unique_violation then
    select credits into left_ from public.profiles where id = p_user; return left_;
  end;
  update public.profiles set credits = greatest(0, credits - p_n) where id = p_user returning credits into left_;
  return left_;
end $$;
revoke execute on function public.remove_credits(uuid, integer, text, text) from public, anon, authenticated;
revoke execute on function public.normalized_email(text) from public, anon, authenticated;
