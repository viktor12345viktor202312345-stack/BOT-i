create table if not exists public.connections (
  conn_id text primary key,
  owner_user_id bigint not null,
  owner_chat_id bigint not null
);

create table if not exists public.messages (
  conn_id text not null,
  chat_id bigint not null,
  msg_id bigint not null,
  from_id bigint,
  from_name text,
  username text,
  text text,
  media_type text,
  file_id text,
  created_at timestamptz not null default now(),
  primary key (conn_id, chat_id, msg_id)
);

-- RLS включён и политик нет: к таблицам имеет доступ только service_role (бот),
-- а публичный anon-ключ не видит ничего.
alter table public.connections enable row level security;
alter table public.messages enable row level security;
