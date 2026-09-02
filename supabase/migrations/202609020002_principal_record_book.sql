begin;

-- Principal-only simplification: current period, category basis, candidate lists and school expenses.
alter table public.financial_categories add column if not exists basis text;
update public.financial_categories
set basis = case when applicable_to_term then 'term' else 'session' end
where basis is null;
alter table public.financial_categories alter column basis set default 'term';
alter table public.financial_categories alter column basis set not null;
alter table public.financial_categories drop constraint if exists financial_categories_basis_check;
alter table public.financial_categories add constraint financial_categories_basis_check check (basis in ('term','session','one_off'));

create table if not exists public.portal_settings (
  id smallint primary key default 1 check (id = 1),
  current_session_id uuid references public.academic_sessions(id) on delete restrict,
  current_term_id uuid references public.terms(id) on delete restrict,
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);

insert into public.portal_settings (id, current_session_id, current_term_id)
select 1, s.id, t.id
from public.academic_sessions s
left join public.terms t on t.session_id = s.id and t.name = 'First Term'
where s.active and not s.is_test
order by s.created_at desc
limit 1
on conflict (id) do nothing;

create table if not exists public.category_candidates (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.financial_categories(id) on delete restrict,
  student_id uuid not null references public.students(id) on delete restrict,
  session_id uuid not null references public.academic_sessions(id) on delete restrict,
  expected_amount_override numeric(12,2) check (expected_amount_override is null or expected_amount_override >= 0),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(category_id, student_id, session_id)
);

create sequence if not exists public.expense_reference_seq;
create table if not exists public.school_expenses (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique default ('ILW-EXP-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.expense_reference_seq')::text, 6, '0')),
  category_id uuid not null references public.financial_categories(id) on delete restrict,
  expense_type text not null check (length(trim(expense_type)) >= 2),
  description text,
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null default current_date,
  session_id uuid not null references public.academic_sessions(id) on delete restrict,
  term_id uuid references public.terms(id) on delete restrict,
  note text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists school_expenses_category_period_idx on public.school_expenses(category_id, session_id, term_id, expense_date desc);

create or replace function private.validate_school_expense()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_basis text;
  v_term_session uuid;
  v_is_test boolean;
begin
  if not private.is_principal(auth.uid()) then raise exception 'Only the Principal can record school expenses'; end if;
  select basis into v_basis from public.financial_categories where id = new.category_id and active;
  if v_basis is null then raise exception 'Financial category is not active'; end if;
  select is_test into v_is_test from public.academic_sessions where id = new.session_id;
  new.is_test := coalesce(v_is_test, false);
  if new.term_id is not null then
    select session_id into v_term_session from public.terms where id = new.term_id;
    if v_term_session is null or v_term_session <> new.session_id then raise exception 'Term and session do not match'; end if;
  end if;
  if v_basis = 'term' and new.term_id is null then raise exception 'A term is required for this category'; end if;
  if v_basis <> 'term' then new.term_id := null; end if;
  new.created_by := auth.uid();
  new.created_at := now();
  new.reference_no := 'ILW-EXP-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.expense_reference_seq')::text, 6, '0');
  return new;
end;
$$;

create or replace function private.prevent_expense_mutation()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  raise exception 'Expense records are protected. Record a correcting entry instead of editing the original.';
end;
$$;

drop trigger if exists school_expenses_validate on public.school_expenses;
create trigger school_expenses_validate before insert on public.school_expenses for each row execute function private.validate_school_expense();
drop trigger if exists school_expenses_immutable on public.school_expenses;
create trigger school_expenses_immutable before update or delete on public.school_expenses for each row execute function private.prevent_expense_mutation();
drop trigger if exists school_expenses_audit on public.school_expenses;
create trigger school_expenses_audit after insert on public.school_expenses for each row execute function private.audit_insert();
create or replace function private.audit_portal_settings()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.audit_logs(actor_id, action, record_type, record_id, metadata)
  values(auth.uid(), 'portal_settings.updated', 'portal_settings', null, jsonb_build_object('new', to_jsonb(new), 'old', case when TG_OP = 'INSERT' then null else to_jsonb(old) end));
  return new;
end;
$$;
drop trigger if exists settings_audit on public.portal_settings;
create trigger settings_audit after insert or update on public.portal_settings for each row execute function private.audit_portal_settings();
drop trigger if exists candidates_audit on public.category_candidates;
create trigger candidates_audit after insert or delete on public.category_candidates for each row execute function private.audit_change();

revoke all on function private.validate_school_expense() from public, anon, authenticated;
revoke all on function private.prevent_expense_mutation() from public, anon, authenticated;
revoke all on function private.audit_portal_settings() from public, anon, authenticated;
grant usage, select on sequence public.expense_reference_seq to authenticated;
grant select, insert on public.school_expenses to authenticated;
grant select, insert, update on public.portal_settings to authenticated;
grant select, insert, delete on public.category_candidates to authenticated;

alter table public.school_expenses enable row level security;
alter table public.portal_settings enable row level security;
alter table public.category_candidates enable row level security;

drop policy if exists school_expenses_select on public.school_expenses;
drop policy if exists school_expenses_insert on public.school_expenses;
drop policy if exists portal_settings_select on public.portal_settings;
drop policy if exists portal_settings_insert on public.portal_settings;
drop policy if exists portal_settings_update on public.portal_settings;
drop policy if exists category_candidates_select on public.category_candidates;
drop policy if exists category_candidates_insert on public.category_candidates;
drop policy if exists category_candidates_delete on public.category_candidates;

create policy school_expenses_select on public.school_expenses for select to authenticated using (private.is_principal());
create policy school_expenses_insert on public.school_expenses for insert to authenticated with check (private.is_principal() and created_by = auth.uid());
create policy portal_settings_select on public.portal_settings for select to authenticated using (private.is_principal());
create policy portal_settings_insert on public.portal_settings for insert to authenticated with check (private.is_principal());
create policy portal_settings_update on public.portal_settings for update to authenticated using (private.is_principal()) with check (private.is_principal());
create policy category_candidates_select on public.category_candidates for select to authenticated using (private.is_principal());
create policy category_candidates_insert on public.category_candidates for insert to authenticated with check (private.is_principal() and created_by = auth.uid());
create policy category_candidates_delete on public.category_candidates for delete to authenticated using (private.is_principal());

-- Keep legacy boolean aligned for existing payment validation while the new UI uses basis.
create or replace function private.sync_category_basis()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if new.basis is null then new.basis := case when new.applicable_to_term then 'term' else 'session' end; end if;
  new.applicable_to_term := new.basis = 'term';
  return new;
end;
$$;
drop trigger if exists categories_sync_basis on public.financial_categories;
create trigger categories_sync_basis before insert or update on public.financial_categories for each row execute function private.sync_category_basis();
revoke all on function private.sync_category_basis() from public, anon, authenticated;

update public.financial_categories set basis = 'term' where name = 'School Fees';
update public.financial_categories set basis = 'session' where name in ('WAEC','NECO','BECE','JUPEB');

commit;
