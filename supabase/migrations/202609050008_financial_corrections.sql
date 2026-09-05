begin;

-- Principal payment correction helper -------------------------------------------------
-- Existing student payment correction tables remain the source of truth. This migration
-- adds a simple atomic Principal action while preserving the full audit trail.

create or replace view public.effective_payment_ledger
with (security_invoker = true)
as
select p.*
from public.student_payments p
where p.status = 'posted'
  and not exists (
    select 1
    from public.payment_corrections pc
    where pc.original_payment_id = p.id
      and pc.status = 'approved'
  )
  and (
    not p.is_correction
    or exists (
      select 1
      from public.payment_corrections pc
      where pc.replacement_payment_id = p.id
        and pc.status = 'approved'
    )
  );

grant select on public.effective_payment_ledger to authenticated;

-- Preserve historical class/session context for amount-only correction rows. If an
-- older advanced correction intentionally changes student/category/period, fall back to
-- the normal validation path.
create or replace function private.validate_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student_class uuid;
  v_student_session uuid;
  v_student_status text;
  v_session_is_test boolean;
  v_term_session uuid;
  v_category_term boolean;
  v_category_scope text;
  v_category_name text;
  v_origin public.student_payments;
  v_simple_correction boolean := false;
begin
  if new.is_correction then
    if new.correction_request_id is null or new.origin_payment_id is null then
      raise exception 'A correction payment must carry correction links';
    end if;

    select * into v_origin
    from public.student_payments
    where id = new.origin_payment_id;

    if v_origin.id is null then
      raise exception 'Original payment was not found';
    end if;

    v_simple_correction :=
      new.student_id = v_origin.student_id
      and new.class_id = v_origin.class_id
      and new.category_id = v_origin.category_id
      and new.session_id = v_origin.session_id
      and new.term_id is not distinct from v_origin.term_id;

    if v_simple_correction then
      new.is_test := v_origin.is_test;
      new.reference_no := 'ILW-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.payment_reference_seq')::text, 6, '0');
      new.collected_at := now();
      new.created_at := now();
      if new.collector_id is null then raise exception 'Collector is required'; end if;
      return new;
    end if;
  end if;

  select class_id, academic_session_id, status
    into v_student_class, v_student_session, v_student_status
  from public.students
  where id = new.student_id;

  if v_student_class is null or v_student_class <> new.class_id then
    raise exception 'Student and class do not match';
  end if;
  if v_student_session is null or v_student_session <> new.session_id then
    raise exception 'Student and academic session do not match';
  end if;
  if not new.is_correction and v_student_status <> 'active' then
    raise exception 'Payments can only be recorded for active students';
  end if;

  select is_test into v_session_is_test
  from public.academic_sessions
  where id = new.session_id;
  new.is_test := coalesce(v_session_is_test, false);

  select applicable_to_term, candidate_scope, upper(name)
    into v_category_term, v_category_scope, v_category_name
  from public.financial_categories
  where id = new.category_id and (active or new.is_correction);

  if v_category_term is null then
    raise exception 'Financial category is not available';
  end if;

  if not exists (
    select 1 from public.financial_category_classes
    where category_id = new.category_id and class_id = new.class_id
  ) then
    raise exception 'This financial category does not apply to the selected class';
  end if;

  if not new.is_correction
     and v_category_scope = 'mixed'
     and v_category_name in ('WAEC','NECO')
     and not exists (
       select 1
       from public.category_candidates cc
       where cc.category_id = new.category_id
         and cc.student_id = new.student_id
         and cc.session_id = new.session_id
     ) then
    raise exception 'Student is not registered as an internal % candidate', v_category_name;
  end if;

  if new.term_id is not null then
    select session_id into v_term_session from public.terms where id = new.term_id;
    if v_term_session is null or v_term_session <> new.session_id then
      raise exception 'Term and academic session do not match';
    end if;
  elsif v_category_term then
    raise exception 'A term is required for this financial category';
  end if;

  if not v_category_term and new.term_id is not null then
    raise exception 'This financial category is not term-specific';
  end if;

  if not new.is_correction then
    if new.correction_request_id is not null or new.origin_payment_id is not null then
      raise exception 'A normal payment cannot carry correction links';
    end if;
    new.reference_no := 'ILW-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.payment_reference_seq')::text, 6, '0');
    new.collected_at := now();
  end if;

  new.created_at := now();
  if new.collector_id is null then raise exception 'Collector is required'; end if;
  return new;
end;
$$;

revoke all on function private.validate_payment() from public, anon, authenticated;

create or replace function public.principal_correct_payment(
  p_original_id uuid,
  p_action text,
  p_amount numeric default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_original public.student_payments;
  v_request_id uuid;
  v_result jsonb;
  v_action public.correction_action;
begin
  if v_user is null or not private.is_principal(v_user) then
    raise exception 'Only the Principal can apply payment corrections';
  end if;

  if lower(coalesce(p_action,'')) not in ('correct','reverse') then
    raise exception 'Correction action must be correct or reverse';
  end if;
  v_action := lower(p_action)::public.correction_action;

  if length(trim(coalesce(p_reason,''))) < 5 then
    raise exception 'Enter a correction reason of at least 5 characters';
  end if;
  if v_action = 'correct' and (p_amount is null or p_amount <= 0) then
    raise exception 'Enter a valid corrected amount';
  end if;

  select * into v_original
  from public.student_payments
  where id = p_original_id
  for update;

  if v_original.id is null then raise exception 'Payment was not found'; end if;
  if exists (
    select 1 from public.payment_corrections
    where original_payment_id = v_original.id and status = 'approved'
  ) then
    raise exception 'This payment has already been corrected';
  end if;
  if v_original.is_correction and not exists (
    select 1 from public.payment_corrections
    where replacement_payment_id = v_original.id and status = 'approved'
  ) then
    raise exception 'This correction payment is not an effective ledger entry';
  end if;

  insert into public.payment_correction_requests(
    original_payment_id, action, requested_amount, reason, requested_by, status
  ) values (
    v_original.id,
    v_action,
    case when v_action = 'correct' then p_amount else null end,
    trim(p_reason),
    v_user,
    'pending'
  ) returning id into v_request_id;

  v_result := public.review_payment_correction(v_request_id, true, 'Applied directly by the Principal');

  return coalesce(v_result, '{}'::jsonb) || jsonb_build_object(
    'request_id', v_request_id,
    'original_payment_id', v_original.id,
    'action', v_action
  );
end;
$$;

revoke all on function public.principal_correct_payment(uuid, text, numeric, text) from public, anon;
grant execute on function public.principal_correct_payment(uuid, text, numeric, text) to authenticated;

-- Let the Principal also use the underlying request workflow for any school payment,
-- while non-principal staff retain the original own-payment-only restriction.
drop policy if exists correction_requests_insert on public.payment_correction_requests;
create policy correction_requests_insert on public.payment_correction_requests
for insert to authenticated
with check (
  requested_by = auth.uid()
  and private.has_permission('record_student_payments')
  and status = 'pending'
  and (
    private.is_principal()
    or exists (
      select 1 from public.student_payments p
      where p.id = original_payment_id and p.collector_id = auth.uid()
    )
  )
);

-- School expense corrections ---------------------------------------------------------
create table if not exists public.school_expense_correction_requests (
  id uuid primary key default gen_random_uuid(),
  original_expense_id uuid not null references public.school_expenses(id) on delete restrict,
  action public.correction_action not null,
  requested_amount numeric(12,2),
  reason text not null check (length(trim(reason)) >= 5),
  requested_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  status public.correction_status not null default 'approved',
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (action = 'reverse' and requested_amount is null)
    or (action = 'correct' and requested_amount is not null and requested_amount > 0)
  )
);

alter table public.school_expenses add column if not exists is_correction boolean not null default false;
alter table public.school_expenses add column if not exists correction_request_id uuid;
alter table public.school_expenses add column if not exists origin_expense_id uuid;

alter table public.school_expenses drop constraint if exists school_expenses_correction_request_id_fkey;
alter table public.school_expenses add constraint school_expenses_correction_request_id_fkey
  foreign key (correction_request_id) references public.school_expense_correction_requests(id) on delete restrict;
alter table public.school_expenses drop constraint if exists school_expenses_origin_expense_id_fkey;
alter table public.school_expenses add constraint school_expenses_origin_expense_id_fkey
  foreign key (origin_expense_id) references public.school_expenses(id) on delete restrict;

create table if not exists public.school_expense_corrections (
  id uuid primary key default gen_random_uuid(),
  correction_request_id uuid not null unique references public.school_expense_correction_requests(id) on delete restrict,
  original_expense_id uuid not null unique references public.school_expenses(id) on delete restrict,
  replacement_expense_id uuid unique references public.school_expenses(id) on delete restrict,
  action public.correction_action not null,
  original_amount numeric(12,2) not null check (original_amount > 0),
  status public.correction_status not null default 'approved',
  approved_by uuid not null references public.profiles(id) on delete restrict,
  approved_at timestamptz not null default now()
);

create index if not exists school_expense_corrections_original_idx
  on public.school_expense_corrections(original_expense_id, status);

create or replace function private.validate_school_expense()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_basis text;
  v_term_session uuid;
  v_is_test boolean;
  v_origin public.school_expenses;
begin
  if not private.is_principal(auth.uid()) then
    raise exception 'Only the Principal can record school expenses';
  end if;

  if new.is_correction then
    if new.correction_request_id is null or new.origin_expense_id is null then
      raise exception 'A correction expense must carry correction links';
    end if;
    select * into v_origin from public.school_expenses where id = new.origin_expense_id;
    if v_origin.id is null then raise exception 'Original expense was not found'; end if;
    if new.category_id <> v_origin.category_id
       or new.session_id <> v_origin.session_id
       or new.term_id is distinct from v_origin.term_id then
      raise exception 'A corrected expense must keep the original category and period';
    end if;
    new.is_test := v_origin.is_test;
  else
    if new.correction_request_id is not null or new.origin_expense_id is not null then
      raise exception 'A normal expense cannot carry correction links';
    end if;
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
  end if;

  new.created_by := auth.uid();
  new.created_at := now();
  new.reference_no := 'ILW-EXP-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.expense_reference_seq')::text, 6, '0');
  return new;
end;
$$;

revoke all on function private.validate_school_expense() from public, anon, authenticated;

create or replace view public.effective_school_expense_ledger
with (security_invoker = true)
as
select e.*
from public.school_expenses e
where not exists (
    select 1 from public.school_expense_corrections ec
    where ec.original_expense_id = e.id and ec.status = 'approved'
  )
  and (
    not e.is_correction
    or exists (
      select 1 from public.school_expense_corrections ec
      where ec.replacement_expense_id = e.id and ec.status = 'approved'
    )
  );

grant select on public.effective_school_expense_ledger to authenticated;

create or replace function public.principal_correct_expense(
  p_original_id uuid,
  p_action text,
  p_amount numeric default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_original public.school_expenses;
  v_request_id uuid;
  v_replacement public.school_expenses;
  v_action public.correction_action;
begin
  if v_user is null or not private.is_principal(v_user) then
    raise exception 'Only the Principal can apply expense corrections';
  end if;
  if lower(coalesce(p_action,'')) not in ('correct','reverse') then
    raise exception 'Correction action must be correct or reverse';
  end if;
  v_action := lower(p_action)::public.correction_action;
  if length(trim(coalesce(p_reason,''))) < 5 then
    raise exception 'Enter a correction reason of at least 5 characters';
  end if;
  if v_action = 'correct' and (p_amount is null or p_amount <= 0) then
    raise exception 'Enter a valid corrected amount';
  end if;

  select * into v_original from public.school_expenses where id = p_original_id for update;
  if v_original.id is null then raise exception 'Expense was not found'; end if;
  if exists (
    select 1 from public.school_expense_corrections
    where original_expense_id = v_original.id and status = 'approved'
  ) then raise exception 'This expense has already been corrected'; end if;
  if v_original.is_correction and not exists (
    select 1 from public.school_expense_corrections
    where replacement_expense_id = v_original.id and status = 'approved'
  ) then raise exception 'This correction expense is not an effective ledger entry'; end if;

  insert into public.school_expense_correction_requests(
    original_expense_id, action, requested_amount, reason, requested_by, status, reviewed_by, reviewed_at
  ) values (
    v_original.id, v_action,
    case when v_action = 'correct' then p_amount else null end,
    trim(p_reason), v_user, 'approved', v_user, now()
  ) returning id into v_request_id;

  if v_action = 'correct' then
    insert into public.school_expenses(
      category_id, expense_type, description, amount, expense_date,
      session_id, term_id, note, is_correction, correction_request_id, origin_expense_id
    ) values (
      v_original.category_id, v_original.expense_type, v_original.description, p_amount,
      v_original.expense_date, v_original.session_id, v_original.term_id,
      'Correction replacing ' || v_original.reference_no,
      true, v_request_id, v_original.id
    ) returning * into v_replacement;
  end if;

  insert into public.school_expense_corrections(
    correction_request_id, original_expense_id, replacement_expense_id,
    action, original_amount, status, approved_by
  ) values (
    v_request_id, v_original.id,
    case when v_action = 'correct' then v_replacement.id else null end,
    v_action, v_original.amount, 'approved', v_user
  );

  insert into public.audit_logs(actor_id, action, record_type, record_id, metadata)
  values (
    v_user, 'school_expense.corrected', 'school_expenses', v_original.id,
    jsonb_build_object('action', v_action, 'reason', trim(p_reason), 'original_amount', v_original.amount, 'new_amount', p_amount, 'replacement_id', v_replacement.id)
  );

  return jsonb_build_object(
    'status','approved', 'action',v_action, 'request_id',v_request_id,
    'original_expense_id',v_original.id,
    'replacement_expense_id',case when v_action = 'correct' then v_replacement.id else null end
  );
end;
$$;

revoke all on function public.principal_correct_expense(uuid, text, numeric, text) from public, anon;
grant execute on function public.principal_correct_expense(uuid, text, numeric, text) to authenticated;

alter table public.school_expense_correction_requests enable row level security;
alter table public.school_expense_corrections enable row level security;
drop policy if exists school_expense_correction_requests_select on public.school_expense_correction_requests;
drop policy if exists school_expense_corrections_select on public.school_expense_corrections;
create policy school_expense_correction_requests_select on public.school_expense_correction_requests for select to authenticated using (private.is_principal());
create policy school_expense_corrections_select on public.school_expense_corrections for select to authenticated using (private.is_principal());
grant select on public.school_expense_correction_requests, public.school_expense_corrections to authenticated;

-- External candidate payment corrections ---------------------------------------------
create table if not exists public.external_payment_correction_requests (
  id uuid primary key default gen_random_uuid(),
  original_payment_id uuid not null references public.external_candidate_payments(id) on delete restrict,
  action public.correction_action not null,
  requested_amount numeric(12,2),
  reason text not null check (length(trim(reason)) >= 5),
  requested_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  status public.correction_status not null default 'approved',
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check (
    (action = 'reverse' and requested_amount is null)
    or (action = 'correct' and requested_amount is not null and requested_amount > 0)
  )
);

alter table public.external_candidate_payments add column if not exists is_correction boolean not null default false;
alter table public.external_candidate_payments add column if not exists correction_request_id uuid;
alter table public.external_candidate_payments add column if not exists origin_payment_id uuid;

alter table public.external_candidate_payments drop constraint if exists external_candidate_payments_correction_request_id_fkey;
alter table public.external_candidate_payments add constraint external_candidate_payments_correction_request_id_fkey
  foreign key (correction_request_id) references public.external_payment_correction_requests(id) on delete restrict;
alter table public.external_candidate_payments drop constraint if exists external_candidate_payments_origin_payment_id_fkey;
alter table public.external_candidate_payments add constraint external_candidate_payments_origin_payment_id_fkey
  foreign key (origin_payment_id) references public.external_candidate_payments(id) on delete restrict;

create table if not exists public.external_payment_corrections (
  id uuid primary key default gen_random_uuid(),
  correction_request_id uuid not null unique references public.external_payment_correction_requests(id) on delete restrict,
  original_payment_id uuid not null unique references public.external_candidate_payments(id) on delete restrict,
  replacement_payment_id uuid unique references public.external_candidate_payments(id) on delete restrict,
  action public.correction_action not null,
  original_amount numeric(12,2) not null check (original_amount > 0),
  status public.correction_status not null default 'approved',
  approved_by uuid not null references public.profiles(id) on delete restrict,
  approved_at timestamptz not null default now()
);

create index if not exists external_payment_corrections_original_idx
  on public.external_payment_corrections(original_payment_id, status);

create or replace function private.validate_external_candidate_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_candidate public.external_candidates;
  v_test boolean;
  v_origin public.external_candidate_payments;
begin
  if not private.is_principal(auth.uid()) then
    raise exception 'Only the Principal can record external candidate payments';
  end if;

  if new.is_correction then
    if new.correction_request_id is null or new.origin_payment_id is null then
      raise exception 'A correction external payment must carry correction links';
    end if;
    select * into v_origin from public.external_candidate_payments where id = new.origin_payment_id;
    if v_origin.id is null then raise exception 'Original external payment was not found'; end if;
    if new.external_candidate_id <> v_origin.external_candidate_id
       or new.category_id <> v_origin.category_id
       or new.session_id <> v_origin.session_id then
      raise exception 'A corrected external payment must keep the original candidate, category and session';
    end if;
    new.is_test := v_origin.is_test;
  else
    if new.correction_request_id is not null or new.origin_payment_id is not null then
      raise exception 'A normal external payment cannot carry correction links';
    end if;
    select * into v_candidate from public.external_candidates where id = new.external_candidate_id and active;
    if v_candidate.id is null then raise exception 'External candidate not found'; end if;
    if v_candidate.category_id <> new.category_id then raise exception 'Candidate category does not match payment category'; end if;
    if v_candidate.session_id <> new.session_id then raise exception 'Candidate session does not match payment session'; end if;
    select is_test into v_test from public.academic_sessions where id = new.session_id;
    new.is_test := coalesce(v_test,false);
  end if;

  new.created_by := auth.uid();
  new.created_at := now();
  new.reference_no := 'ILW-EXT-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.external_payment_reference_seq')::text, 6, '0');
  return new;
end;
$$;

revoke all on function private.validate_external_candidate_payment() from public, anon, authenticated;

create or replace view public.effective_external_candidate_payment_ledger
with (security_invoker = true)
as
select p.*
from public.external_candidate_payments p
where not exists (
    select 1 from public.external_payment_corrections ec
    where ec.original_payment_id = p.id and ec.status = 'approved'
  )
  and (
    not p.is_correction
    or exists (
      select 1 from public.external_payment_corrections ec
      where ec.replacement_payment_id = p.id and ec.status = 'approved'
    )
  );

grant select on public.effective_external_candidate_payment_ledger to authenticated;

create or replace function public.principal_correct_external_payment(
  p_original_id uuid,
  p_action text,
  p_amount numeric default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_original public.external_candidate_payments;
  v_request_id uuid;
  v_replacement public.external_candidate_payments;
  v_action public.correction_action;
begin
  if v_user is null or not private.is_principal(v_user) then
    raise exception 'Only the Principal can apply external payment corrections';
  end if;
  if lower(coalesce(p_action,'')) not in ('correct','reverse') then
    raise exception 'Correction action must be correct or reverse';
  end if;
  v_action := lower(p_action)::public.correction_action;
  if length(trim(coalesce(p_reason,''))) < 5 then
    raise exception 'Enter a correction reason of at least 5 characters';
  end if;
  if v_action = 'correct' and (p_amount is null or p_amount <= 0) then
    raise exception 'Enter a valid corrected amount';
  end if;

  select * into v_original from public.external_candidate_payments where id = p_original_id for update;
  if v_original.id is null then raise exception 'External payment was not found'; end if;
  if exists (
    select 1 from public.external_payment_corrections
    where original_payment_id = v_original.id and status = 'approved'
  ) then raise exception 'This external payment has already been corrected'; end if;
  if v_original.is_correction and not exists (
    select 1 from public.external_payment_corrections
    where replacement_payment_id = v_original.id and status = 'approved'
  ) then raise exception 'This correction payment is not an effective ledger entry'; end if;

  insert into public.external_payment_correction_requests(
    original_payment_id, action, requested_amount, reason, requested_by, status, reviewed_by, reviewed_at
  ) values (
    v_original.id, v_action,
    case when v_action = 'correct' then p_amount else null end,
    trim(p_reason), v_user, 'approved', v_user, now()
  ) returning id into v_request_id;

  if v_action = 'correct' then
    insert into public.external_candidate_payments(
      external_candidate_id, category_id, amount_paid, payment_date, session_id,
      note, is_correction, correction_request_id, origin_payment_id
    ) values (
      v_original.external_candidate_id, v_original.category_id, p_amount,
      v_original.payment_date, v_original.session_id,
      'Correction replacing ' || v_original.reference_no,
      true, v_request_id, v_original.id
    ) returning * into v_replacement;
  end if;

  insert into public.external_payment_corrections(
    correction_request_id, original_payment_id, replacement_payment_id,
    action, original_amount, status, approved_by
  ) values (
    v_request_id, v_original.id,
    case when v_action = 'correct' then v_replacement.id else null end,
    v_action, v_original.amount_paid, 'approved', v_user
  );

  insert into public.audit_logs(actor_id, action, record_type, record_id, metadata)
  values (
    v_user, 'external_payment.corrected', 'external_candidate_payments', v_original.id,
    jsonb_build_object('action', v_action, 'reason', trim(p_reason), 'original_amount', v_original.amount_paid, 'new_amount', p_amount, 'replacement_id', v_replacement.id)
  );

  return jsonb_build_object(
    'status','approved', 'action',v_action, 'request_id',v_request_id,
    'original_payment_id',v_original.id,
    'replacement_payment_id',case when v_action = 'correct' then v_replacement.id else null end
  );
end;
$$;

revoke all on function public.principal_correct_external_payment(uuid, text, numeric, text) from public, anon;
grant execute on function public.principal_correct_external_payment(uuid, text, numeric, text) to authenticated;

alter table public.external_payment_correction_requests enable row level security;
alter table public.external_payment_corrections enable row level security;
drop policy if exists external_payment_correction_requests_select on public.external_payment_correction_requests;
drop policy if exists external_payment_corrections_select on public.external_payment_corrections;
create policy external_payment_correction_requests_select on public.external_payment_correction_requests for select to authenticated using (private.is_principal());
create policy external_payment_corrections_select on public.external_payment_corrections for select to authenticated using (private.is_principal());
grant select on public.external_payment_correction_requests, public.external_payment_corrections to authenticated;

commit;
