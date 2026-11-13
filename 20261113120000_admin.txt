create table if not exists public.banned_users (
  user_id bigint primary key,
  banned_at timestamptz not null default now()
);

-- RLS включён и политик нет: доступ только у бота (service_role)
alter table public.banned_users enable row level security;
