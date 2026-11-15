create table if not exists public.rps_games (
  conn_id text not null,
  chat_id bigint not null,
  msg_id bigint not null,
  owner_pick text,
  partner_pick text,
  created_at timestamptz not null default now(),
  primary key (conn_id, chat_id, msg_id)
);

-- RLS включён и политик нет: доступ только у бота (service_role)
alter table public.rps_games enable row level security;
