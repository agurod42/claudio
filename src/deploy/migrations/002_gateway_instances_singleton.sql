with ranked as (
  select
    id,
    row_number() over (
      partition by user_id
      order by
        case status
          when 'running' then 3
          when 'provisioning' then 2
          else 1
        end desc,
        (container_id is not null) desc,
        created_at desc,
        id desc
    ) as rn
  from gateway_instances
)
delete from gateway_instances
where id in (
  select id
  from ranked
  where rn > 1
);

create unique index if not exists gateway_instances_user_unique_idx
  on gateway_instances(user_id);
