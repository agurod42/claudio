alter table gateway_instances add column if not exists gateway_token text;
alter table gateway_instances add column if not exists container_name text;
