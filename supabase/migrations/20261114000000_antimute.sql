create table if not exists public.antimute_chats (
  conn_id text not null,
  chat_id bigint not null,
  primary key (conn_id, chat_id)
);

-- RLS включён и политик нет: доступ только у бота (service_role)
alter table public.antimute_chats enable row level security;
