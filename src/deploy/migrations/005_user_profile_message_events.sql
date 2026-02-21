create table if not exists user_profile_message_events (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  channel text not null default 'whatsapp',
  peer_id text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  content text not null,
  metadata_json text,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists user_profile_message_events_user_idx
  on user_profile_message_events(user_id, occurred_at desc);

create index if not exists user_profile_message_events_user_peer_idx
  on user_profile_message_events(user_id, peer_id, occurred_at desc);
