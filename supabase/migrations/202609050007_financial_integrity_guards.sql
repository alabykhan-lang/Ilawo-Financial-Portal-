begin;

-- Keep category behavior deterministic even when records are written outside
-- the portal UI. Only WAEC and NECO may ever be mixed internal/external funds.
create or replace function private.enforce_category_scope()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.name := trim(new.name);
  if upper(new.name) in ('WAEC','NECO') then
    new.candidate_scope := 'mixed';
  else
    new.candidate_scope := 'internal_only';
  end if;
  return new;
end;
$$;

drop trigger if exists categories_enforce_scope on public.financial_categories;
create trigger categories_enforce_scope
before insert or update of name, candidate_scope on public.financial_categories
for each row execute function private.enforce_category_scope();

revoke all on function private.enforce_category_scope() from public, anon, authenticated;

-- An internal exam registration is meaningful only when the selected student
-- belongs to the same session and to a class configured for WAEC/NECO.
create or replace function private.validate_category_candidate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_scope text;
  v_name text;
  v_student_session uuid;
  v_student_class uuid;
  v_student_status text;
begin
  if not private.is_principal(auth.uid()) then
    raise exception 'Only the Principal can manage internal exam candidates';
  end if;

  select candidate_scope, upper(name)
    into v_scope, v_name
  from public.financial_categories
  where id = new.category_id and active;

  if v_scope is null or v_scope <> 'mixed' or v_name not in ('WAEC','NECO') then
    raise exception 'Internal candidate registration is only used for WAEC and NECO';
  end if;

  select academic_session_id, class_id, status
    into v_student_session, v_student_class, v_student_status
  from public.students
  where id = new.student_id;

  if v_student_session is null then
    raise exception 'Student was not found';
  end if;
  if v_student_session <> new.session_id then
    raise exception 'Student and candidate registration session do not match';
  end if;
  if v_student_status <> 'active' then
    raise exception 'Only active internal students can be registered as exam candidates';
  end if;
  if not exists (
    select 1
    from public.financial_category_classes cc
    where cc.category_id = new.category_id
      and cc.class_id = v_student_class
  ) then
    raise exception 'This exam does not apply to the student class';
  end if;

  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists category_candidates_validate on public.category_candidates;
create trigger category_candidates_validate
before insert on public.category_candidates
for each row execute function private.validate_category_candidate();

revoke all on function private.validate_category_candidate() from public, anon, authenticated;

-- Harden the payment validator so WAEC/NECO internal payments cannot bypass
-- explicit candidate registration when written through another authenticated
-- client. Correction rows remain compatible with historical records.
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
begin
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
    raise exception 'Financial category is not active';
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
  elsif new.correction_request_id is null or new.origin_payment_id is null then
    raise exception 'A correction payment must carry correction links';
  end if;

  new.created_at := now();
  if new.collector_id is null then
    raise exception 'Collector is required';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_payment() from public, anon, authenticated;

-- Final policy normalization for the fixed school rules.
update public.financial_categories
set candidate_scope = case when upper(name) in ('WAEC','NECO') then 'mixed' else 'internal_only' end;

commit;
