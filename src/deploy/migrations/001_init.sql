create table if not exists users (
  id text primary key,
  whatsapp_id text not null unique,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists agents (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  gateway_instance_id text,
  model_tier text not null,
  name text,
  tone text,
  language text,
  allowlist_only boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists login_sessions (
  id text primary key,
  user_id text references users(id) on delete set null,
  state text not null,
  error_code text,
  error_message text,
  auth_dir text not null,
  whatsapp_id text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists gateway_instances (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  container_id text,
  status text not null,
  auth_dir_path text not null,
  created_at timestamptz not null default now()
);

create table if not exists usage_daily (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  usage_date date not null,
  messages_count integer not null default 0,
  media_bytes bigint not null default 0
);

create index if not exists login_sessions_state_idx on login_sessions(state);
create index if not exists login_sessions_expires_idx on login_sessions(expires_at);
create index if not exists agents_user_idx on agents(user_id);
create index if not exists gateway_instances_user_idx on gateway_instances(user_id);
create index if not exists usage_daily_user_idx on usage_daily(user_id);
