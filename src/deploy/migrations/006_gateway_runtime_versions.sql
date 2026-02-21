alter table gateway_instances
  add column if not exists config_version text not null default '';

alter table gateway_instances
  add column if not exists plugin_version text not null default '';

alter table gateway_instances
  add column if not exists runtime_policy_version text not null default '';

alter table gateway_instances
  add column if not exists image_ref text not null default '';

alter table gateway_instances
  add column if not exists reconciled_at timestamptz;
