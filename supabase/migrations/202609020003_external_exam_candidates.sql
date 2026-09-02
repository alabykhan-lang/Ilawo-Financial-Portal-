begin;

-- Allow common senior external-exam collections to include SS2 as well as SS3.
insert into public.financial_category_classes (category_id, class_id)
select c.id, cl.id
from public.financial_categories c
join public.classes cl on cl.name in ('SS2','SS3')
where c.name in ('WAEC','NECO','JUPEB')
on conflict do nothing;

create table if not exists public.external_candidates (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(trim(full_name)) >= 2),
  phone text,
  source_school text,
  category_id uuid not null references public.financial_categories(id) on delete restrict,
  session_id uuid not null references public.academic_sessions(id) on delete restrict,
  class_level text check (class_level in ('SS2','SS3','JSS3','Other')),
  expected_amount numeric(12,2) check (expected_amount is null or expected_amount >= 0),
  active boolean not null default true,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create sequence if not exists public.external_payment_reference_seq;
create table if not exists public.external_candidate_payments (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique default ('ILW-EXT-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.external_payment_reference_seq')::text, 6, '0')),
  external_candidate_id uuid not null references public.external_candidates(id) on delete restrict,
  category_id uuid not null references public.financial_categories(id) on delete restrict,
  amount_paid numeric(12,2) not null check (amount_paid > 0),
  payment_date date not null default current_date,
  session_id uuid not null references public.academic_sessions(id) on delete restrict,
  note text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists external_candidates_category_session_idx on public.external_candidates(category_id, session_id, active);
create index if not exists external_payments_category_session_idx on public.external_candidate_payments(category_id, session_id, payment_date desc);

create or replace function private.validate_external_candidate_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate public.external_candidates;
  v_test boolean;
begin
  if not private.is_principal(auth.uid()) then
    raise exception 'Only the Principal can record external candidate payments';
  end if;
  select * into v_candidate from public.external_candidates where id = new.external_candidate_id and active;
  if v_candidate.id is null then raise exception 'External candidate not found'; end if;
  if v_candidate.category_id <> new.category_id then raise exception 'Candidate category does not match payment category'; end if;
  if v_candidate.session_id <> new.session_id then raise exception 'Candidate session does not match payment session'; end if;
  select is_test into v_test from public.academic_sessions where id = new.session_id;
  new.is_test := coalesce(v_test,false);
  new.created_by := auth.uid();
  new.created_at := now();
  new.reference_no := 'ILW-EXT-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.external_payment_reference_seq')::text, 6, '0');
  return new;
end;
$$;

create or replace function private.prevent_external_payment_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'External candidate payments are protected. Add a correcting entry instead of editing the original.';
end;
$$;

drop trigger if exists external_payments_validate on public.external_candidate_payments;
create trigger external_payments_validate before insert on public.external_candidate_payments for each row execute function private.validate_external_candidate_payment();
drop trigger if exists external_payments_immutable on public.external_candidate_payments;
create trigger external_payments_immutable before update or delete on public.external_candidate_payments for each row execute function private.prevent_external_payment_mutation();
drop trigger if exists external_candidates_audit on public.external_candidates;
create trigger external_candidates_audit after insert or update on public.external_candidates for each row execute function private.audit_change();
drop trigger if exists external_payments_audit on public.external_candidate_payments;
create trigger external_payments_audit after insert on public.external_candidate_payments for each row execute function private.audit_insert();

revoke all on function private.validate_external_candidate_payment() from public, anon, authenticated;
revoke all on function private.prevent_external_payment_mutation() from public, anon, authenticated;
grant usage, select on sequence public.external_payment_reference_seq to authenticated;
grant select, insert, update on public.external_candidates to authenticated;
grant select, insert on public.external_candidate_payments to authenticated;

alter table public.external_candidates enable row level security;
alter table public.external_candidate_payments enable row level security;

drop policy if exists external_candidates_select on public.external_candidates;
drop policy if exists external_candidates_insert on public.external_candidates;
drop policy if exists external_candidates_update on public.external_candidates;
drop policy if exists external_payments_select on public.external_candidate_payments;
drop policy if exists external_payments_insert on public.external_candidate_payments;

create policy external_candidates_select on public.external_candidates for select to authenticated using (private.is_principal());
create policy external_candidates_insert on public.external_candidates for insert to authenticated with check (private.is_principal() and created_by = auth.uid());
create policy external_candidates_update on public.external_candidates for update to authenticated using (private.is_principal()) with check (private.is_principal());
create policy external_payments_select on public.external_candidate_payments for select to authenticated using (private.is_principal());
create policy external_payments_insert on public.external_candidate_payments for insert to authenticated with check (private.is_principal() and created_by = auth.uid());

commit;
