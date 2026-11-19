create table if not exists public.chess_games (
  conn_id text not null,
  chat_id bigint not null,
  msg_id bigint not null,
  fen text not null,
  selected smallint,
  white_owner boolean not null,
  last_from smallint,
  last_to smallint,
  last_piece text,
  result text,
  created_at timestamptz not null default now(),
  primary key (conn_id, chat_id, msg_id)
);

-- RLS включён и политик нет: доступ только у бота (service_role)
alter table public.chess_games enable row level security;
