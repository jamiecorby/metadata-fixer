-- The AI rate limit filters by user and recent time; a composite index serves it (the single-column index was unused).
drop index if exists public.ai_requests_user_idx;
create index if not exists ai_requests_user_created_idx on public.ai_requests (user_id, created_at desc);
