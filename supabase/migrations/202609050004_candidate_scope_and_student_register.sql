begin;

-- Category behavior: only WAEC and NECO support both internal and external candidates.
alter table public.financial_categories
  add column if not exists candidate_scope text;

update public.financial_categories
set candidate_scope = case when upper(name) in ('WAEC','NECO') then 'mixed' else 'internal_only' end
where candidate_scope is null;

alter table public.financial_categories
  alter column candidate_scope set default 'internal_only';
alter table public.financial_categories
  alter column candidate_scope set not null;
alter table public.financial_categories
  drop constraint if exists financial_categories_candidate_scope_check;
alter table public.financial_categories
  add constraint financial_categories_candidate_scope_check
  check (candidate_scope in ('internal_only','mixed'));

-- Correct the category name. If U.P.E already exists, keep the existing row and
-- move safe configuration references from the old JUPEB row before deactivating it.
do $$
declare
  v_old uuid;
  v_new uuid;
begin
  select id into v_old from public.financial_categories where upper(name) = 'JUPEB' limit 1;
  select id into v_new from public.financial_categories where upper(name) = 'U.P.E' limit 1;

  if v_old is not null and v_new is null then
    update public.financial_categories
      set name = 'U.P.E', candidate_scope = 'internal_only'
      where id = v_old;
  elsif v_old is not null and v_new is not null and v_old <> v_new then
    insert into public.financial_category_classes(category_id, class_id)
      select v_new, class_id from public.financial_category_classes where category_id = v_old
      on conflict do nothing;
    update public.financial_categories set active = false where id = v_old;
    update public.financial_categories set candidate_scope = 'internal_only' where id = v_new;
  end if;
end $$;

update public.financial_categories
set candidate_scope = case when upper(name) in ('WAEC','NECO') then 'mixed' else 'internal_only' end;

-- Extend the internal school register with guardian details. External exam
-- candidates remain in external_candidates and never enter this table.
alter table public.students add column if not exists guardian_name text;
alter table public.students add column if not exists guardian_phone text;
alter table public.students add column if not exists guardian_email text;

-- Only WAEC and NECO can accept external candidates from now on.
create or replace function private.validate_external_candidate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_name text;
  v_scope text;
begin
  if not private.is_principal(auth.uid()) then
    raise exception 'Only the Principal can manage external candidates';
  end if;

  select upper(name), candidate_scope into v_name, v_scope
  from public.financial_categories
  where id = new.category_id and active;

  if v_name is null then
    raise exception 'Financial category is not active';
  end if;
  if v_scope <> 'mixed' or v_name not in ('WAEC','NECO') then
    raise exception 'External candidates are only allowed for WAEC and NECO';
  end if;

  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end;
$$;

drop trigger if exists external_candidates_validate on public.external_candidates;
create trigger external_candidates_validate
before insert or update on public.external_candidates
for each row execute function private.validate_external_candidate();

revoke all on function private.validate_external_candidate() from public, anon, authenticated;

-- Add indexes that make the Principal's master register and reports faster.
create index if not exists students_session_class_status_idx
  on public.students(academic_session_id, class_id, status, full_name);
create index if not exists students_guardian_phone_idx
  on public.students(guardian_phone)
  where guardian_phone is not null;

-- Keep WAEC and NECO open to internal SS2/SS3 students as previously requested.
insert into public.financial_category_classes(category_id, class_id)
select c.id, cl.id
from public.financial_categories c
join public.classes cl on cl.name in ('SS2','SS3')
where upper(c.name) in ('WAEC','NECO')
on conflict do nothing;

-- U.P.E and every non-WAEC/NECO category are internal-use categories.
update public.financial_categories
set candidate_scope = 'internal_only'
where upper(name) not in ('WAEC','NECO');

commit;
