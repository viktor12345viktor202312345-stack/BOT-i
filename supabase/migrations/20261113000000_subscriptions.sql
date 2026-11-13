create table if not exists public.subscriptions (
  user_id bigint primary key,
  expires_at timestamptz not null,
  expired_notified boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.payments (
  charge_id text primary key,
  user_id bigint not null,
  plan text not null,
  stars integer not null,
  created_at timestamptz not null default now()
);

-- RLS включён и политик нет: доступ только у бота (service_role)
alter table public.subscriptions enable row level security;
alter table public.payments enable row level security;
