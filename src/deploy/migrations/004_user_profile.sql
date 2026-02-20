create table if not exists user_profile_data (
  id text primary key,
  user_id text not null unique references users(id) on delete cascade,
  display_name text,
  contacts_json text,
  chats_json text,
  messages_json text,
  profile_md text,
  profile_updated_at timestamptz,
  raw_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
