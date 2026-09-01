begin;

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'app_role') then
    create type public.app_role as enum ('principal', 'staff');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'payment_status') then
    create type public.payment_status as enum ('posted');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'handover_status') then
    create type public.handover_status as enum ('pending', 'confirmed', 'rejected');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'correction_action') then
    create type public.correction_action as enum ('reverse', 'correct');
  end if;
  if not exists (select 1 from pg_type where typnamespace = 'public'::regnamespace and typname = 'correction_status') then
    create type public.correction_status as enum ('pending', 'approved', 'rejected');
  end if;
end $$;

create sequence if not exists public.payment_reference_seq;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) >= 2),
  email text,
  role public.app_role not null default 'staff',
  active boolean not null default true,
  staff_code text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.permissions (
  key text primary key,
  label text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.profile_permissions (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (profile_id, permission_key)
);

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  display_order integer not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.academic_sessions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  starts_on date,
  ends_on date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.terms (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.academic_sessions(id) on delete cascade,
  name text not null check (name in ('First Term', 'Second Term', 'Third Term')),
  display_order integer not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (session_id, name)
);

create table if not exists public.financial_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  applicable_to_term boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.financial_category_classes (
  category_id uuid not null references public.financial_categories(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  primary key (category_id, class_id)
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  admission_no text not null unique,
  full_name text not null check (length(trim(full_name)) >= 2),
  class_id uuid not null references public.classes(id) on delete restrict,
  arm text,
  status text not null default 'active' check (status in ('active', 'inactive', 'graduated', 'withdrawn')),
  academic_session_id uuid not null references public.academic_sessions(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.expected_charges (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.financial_categories(id) on delete restrict,
  class_id uuid not null references public.classes(id) on delete restrict,
  session_id uuid not null references public.academic_sessions(id) on delete restrict,
  term_id uuid references public.terms(id) on delete restrict,
  expected_amount numeric(12, 2) not null check (expected_amount >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists expected_charges_unique_idx
  on public.expected_charges (category_id, class_id, session_id, coalesce(term_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.student_payments (
  id uuid primary key default gen_random_uuid(),
  reference_no text not null unique default ('ILW-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(nextval('public.payment_reference_seq')::text, 6, '0')),
  student_id uuid not null references public.students(id) on delete restrict,
  class_id uuid not null references public.classes(id) on delete restrict,
  category_id uuid not null references public.financial_categories(id) on delete restrict,
  amount_paid numeric(12, 2) not null check (amount_paid > 0),
  payment_date date not null default current_date,
  collected_at timestamptz not null default now(),
  collector_id uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  session_id uuid not null references public.academic_sessions(id) on delete restrict,
  term_id uuid references public.terms(id) on delete restrict,
  note text,
  status public.payment_status not null default 'posted',
  is_correction boolean not null default false,
  correction_request_id uuid,
  origin_payment_id uuid references public.student_payments(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.payment_correction_requests (
  id uuid primary key default gen_random_uuid(),
  original_payment_id uuid not null references public.student_payments(id) on delete restrict,
  action public.correction_action not null,
  requested_amount numeric(12, 2),
  requested_student_id uuid references public.students(id) on delete restrict,
  requested_category_id uuid references public.financial_categories(id) on delete restrict,
  requested_session_id uuid references public.academic_sessions(id) on delete restrict,
  requested_term_id uuid references public.terms(id) on delete restrict,
  reason text not null check (length(trim(reason)) >= 5),
  requested_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  status public.correction_status not null default 'pending',
  reviewed_by uuid references public.profiles(id) on delete restrict,
  reviewed_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  check (
    (action = 'reverse' and requested_amount is null)
    or (action = 'correct' and requested_amount is not null and requested_amount > 0)
  )
);

alter table public.student_payments
  drop constraint if exists student_payments_correction_request_id_fkey;
alter table public.student_payments
  add constraint student_payments_correction_request_id_fkey
  foreign key (correction_request_id) references public.payment_correction_requests(id) on delete restrict;

create table if not exists public.payment_corrections (
  id uuid primary key default gen_random_uuid(),
  correction_request_id uuid not null unique references public.payment_correction_requests(id) on delete restrict,
  original_payment_id uuid not null unique references public.student_payments(id) on delete restrict,
  replacement_payment_id uuid unique references public.student_payments(id) on delete restrict,
  action public.correction_action not null,
  original_amount numeric(12, 2) not null check (original_amount > 0),
  status public.correction_status not null default 'approved',
  approved_by uuid not null references public.profiles(id) on delete restrict,
  approved_at timestamptz not null default now()
);

create table if not exists public.handovers (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles(id) on delete restrict,
  total_amount numeric(12, 2) not null default 0 check (total_amount >= 0),
  status public.handover_status not null default 'pending',
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete restrict,
  decision_note text,
  created_at timestamptz not null default now()
);

create table if not exists public.handover_items (
  id uuid primary key default gen_random_uuid(),
  handover_id uuid not null references public.handovers(id) on delete restrict,
  payment_id uuid not null references public.student_payments(id) on delete restrict,
  amount numeric(12, 2) not null check (amount > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (handover_id, payment_id)
);

create unique index if not exists handover_items_active_payment_idx
  on public.handover_items (payment_id) where is_active;

create table if not exists public.personal_products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  cost_price numeric(12, 2) not null check (cost_price >= 0),
  selling_price numeric(12, 2) not null check (selling_price >= 0),
  quantity integer not null default 0 check (quantity >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.personal_sales (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.personal_products(id) on delete restrict,
  quantity integer not null check (quantity > 0),
  unit_cost numeric(12, 2) not null check (unit_cost >= 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  sold_at timestamptz not null default now(),
  note text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.personal_sales add column if not exists unit_cost numeric(12, 2);
update public.personal_sales set unit_cost = 0 where unit_cost is null;
alter table public.personal_sales alter column unit_cost set not null;
alter table public.personal_sales drop constraint if exists personal_sales_unit_cost_check;
alter table public.personal_sales add constraint personal_sales_unit_cost_check check (unit_cost >= 0);

create table if not exists public.personal_expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null check (length(trim(description)) >= 2),
  amount numeric(12, 2) not null check (amount > 0),
  expense_date date not null default current_date,
  note text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  record_type text not null,
  record_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists students_class_idx on public.students(class_id);
create index if not exists students_session_idx on public.students(academic_session_id);
create index if not exists payments_student_idx on public.student_payments(student_id);
create index if not exists payments_collector_idx on public.student_payments(collector_id, collected_at desc);
create index if not exists payments_category_idx on public.student_payments(category_id, payment_date desc);
create index if not exists corrections_original_idx on public.payment_correction_requests(original_payment_id);
create index if not exists handovers_staff_idx on public.handovers(staff_id, submitted_at desc);
create index if not exists audit_created_idx on public.audit_logs(created_at desc);

insert into public.permissions (key, label, description) values
  ('record_student_payments', 'Record student payments', 'Create new locked payment records.'),
  ('view_students', 'View students', 'View student names, classes and ledgers.'),
  ('view_own_collections', 'View own collections', 'View payments personally recorded.'),
  ('view_all_collections', 'View all collections', 'View collections recorded by all staff.'),
  ('create_handover', 'Create handover', 'Submit money in personal custody for confirmation.'),
  ('confirm_handovers', 'Confirm handovers', 'Confirm or reject staff handovers.'),
  ('view_school_reports', 'View school reports', 'View principal-level collection summaries.'),
  ('manage_financial_categories', 'Manage financial categories', 'Manage charges and applicable classes.'),
  ('manage_students', 'Manage students', 'Import and update student records.'),
  ('manage_staff', 'Manage staff', 'Create staff, disable accounts and set permissions.'),
  ('principal_dashboard', 'Principal/Admin dashboard', 'Open principal-level financial controls.'),
  ('personal_business', 'Personal Business access', 'View and manage the private business section.')
on conflict (key) do update set label = excluded.label, description = excluded.description;

insert into public.classes (name, display_order) values
  ('JSS1', 1), ('JSS2', 2), ('JSS3', 3), ('SS1', 4), ('SS2', 5), ('SS3', 6)
on conflict (name) do update set display_order = excluded.display_order, active = true;

insert into public.academic_sessions (name, starts_on, active)
values ('2026/2027', '2026-09-01', true)
on conflict (name) do update set active = true;

insert into public.terms (session_id, name, display_order)
select s.id, v.name, v.display_order
from public.academic_sessions s
cross join (values ('First Term', 1), ('Second Term', 2), ('Third Term', 3)) as v(name, display_order)
where s.name = '2026/2027'
on conflict (session_id, name) do update set display_order = excluded.display_order, active = true;

insert into public.financial_categories (name, applicable_to_term) values
  ('School Fees', true), ('WAEC', false), ('NECO', false), ('BECE', false), ('JUPEB', false)
on conflict (name) do update set active = true;

insert into public.financial_category_classes (category_id, class_id)
select c.id, cl.id
from public.financial_categories c
cross join public.classes cl
where c.name = 'School Fees' and cl.active
on conflict do nothing;

insert into public.financial_category_classes (category_id, class_id)
select c.id, cl.id
from public.financial_categories c
join public.classes cl on cl.name = 'SS3'
where c.name in ('WAEC', 'NECO', 'JUPEB')
on conflict do nothing;

insert into public.financial_category_classes (category_id, class_id)
select c.id, cl.id
from public.financial_categories c
join public.classes cl on cl.name = 'JSS3'
where c.name = 'BECE'
on conflict do nothing;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(coalesce(new.email, 'staff'), '@', 1)),
    new.email
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create or replace function private.has_permission(p_permission_key text, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.profile_permissions pp
      on pp.profile_id = p.id and pp.permission_key = p_permission_key
    where p.id = coalesce(p_user_id, auth.uid())
      and p.active
      and (p.role = 'principal' or pp.permission_key is not null)
  );
$$;

create or replace function private.is_principal(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles
    where id = coalesce(p_user_id, auth.uid()) and active and role = 'principal'
  );
$$;

create or replace function private.validate_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student_class uuid;
  v_student_session uuid;
  v_term_session uuid;
  v_category_term boolean;
begin
  select class_id, academic_session_id into v_student_class, v_student_session
  from public.students
  where id = new.student_id;
  if v_student_class is null or v_student_class <> new.class_id then
    raise exception 'Student and class do not match';
  end if;
  if v_student_session is null or v_student_session <> new.session_id then
    raise exception 'Student and academic session do not match';
  end if;
  select applicable_to_term into v_category_term
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
    new.collected_at = now();
  elsif new.correction_request_id is null or new.origin_payment_id is null then
    raise exception 'A correction payment must carry correction links';
  end if;
  new.created_at = now();
  if new.collector_id is null then
    raise exception 'Collector is required';
  end if;
  return new;
end;
$$;

create or replace function private.prevent_payment_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'Payment records are immutable. Use the correction workflow.';
end;
$$;

create or replace function private.audit_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_logs (actor_id, action, record_type, record_id, metadata)
  values (
    auth.uid(),
    lower(TG_TABLE_NAME) || '.created',
    TG_TABLE_NAME,
    new.id,
    jsonb_build_object('new', to_jsonb(new))
  );
  return new;
end;
$$;

create or replace function private.audit_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_logs (actor_id, action, record_type, record_id, metadata)
  values (
    auth.uid(),
    lower(TG_TABLE_NAME) || case when TG_OP = 'INSERT' then '.created' else '.updated' end,
    TG_TABLE_NAME,
    case when TG_OP = 'DELETE' then old.id else new.id end,
    jsonb_build_object(
      'operation', TG_OP,
      'new', case when TG_OP = 'DELETE' then null else to_jsonb(new) end,
      'old', case when TG_OP = 'INSERT' then null else to_jsonb(old) end
    )
  );
  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.create_handover(p_payment_ids uuid[])
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_handover_id uuid;
  v_total numeric(12, 2) := 0;
  v_expected_count integer := 0;
  v_found_count integer := 0;
  v_unique_count integer := 0;
  v_payment record;
begin
  if v_user is null or not private.has_permission('create_handover', v_user) then
    raise exception 'You do not have permission to create a handover';
  end if;
  select count(*), count(distinct x) into v_expected_count, v_unique_count from unnest(coalesce(p_payment_ids, '{}'::uuid[])) as u(x);
  if v_expected_count = 0 or v_expected_count <> v_unique_count then
    raise exception 'Select one or more unique payments';
  end if;

  for v_payment in
    select p.id, p.amount_paid
    from public.student_payments p
    where p.id = any(p_payment_ids)
      and p.collector_id = v_user
      and p.status = 'posted'
      and not p.is_correction
      and not exists (
        select 1 from public.payment_corrections pc
        where pc.original_payment_id = p.id and pc.status = 'approved'
      )
    for update
  loop
    if exists (select 1 from public.handover_items hi where hi.payment_id = v_payment.id and hi.is_active) then
      raise exception 'One or more selected payments are already in an active handover';
    end if;
    v_total := v_total + v_payment.amount_paid;
    v_found_count := v_found_count + 1;
  end loop;

  if v_found_count <> v_unique_count then
    raise exception 'One or more payments are not in your custody';
  end if;

  insert into public.handovers (staff_id, total_amount, status)
  values (v_user, v_total, 'pending')
  returning id into v_handover_id;

  insert into public.handover_items (handover_id, payment_id, amount)
  select v_handover_id, p.id, p.amount_paid
  from public.student_payments p
  where p.id = any(p_payment_ids);

  insert into public.audit_logs (actor_id, action, record_type, record_id, metadata)
  values (v_user, 'handover.submitted', 'handovers', v_handover_id, jsonb_build_object('payment_count', v_unique_count, 'total_amount', v_total));

  return v_handover_id;
end;
$$;

create or replace function public.review_handover(p_handover_id uuid, p_decision text, p_decision_note text default null)
returns public.handovers
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_handover public.handovers;
  v_user uuid := auth.uid();
begin
  if v_user is null or not private.has_permission('confirm_handovers', v_user) then
    raise exception 'You do not have permission to review handovers';
  end if;
  if lower(p_decision) not in ('confirm', 'reject') then
    raise exception 'Decision must be confirm or reject';
  end if;
  select * into v_handover from public.handovers where id = p_handover_id for update;
  if v_handover.id is null or v_handover.status <> 'pending' then
    raise exception 'This handover is no longer pending';
  end if;

  if lower(p_decision) = 'confirm' then
    update public.handovers
    set status = 'confirmed', reviewed_at = now(), reviewed_by = v_user, decision_note = nullif(trim(p_decision_note), '')
    where id = p_handover_id
    returning * into v_handover;
  else
    update public.handovers
    set status = 'rejected', reviewed_at = now(), reviewed_by = v_user, decision_note = nullif(trim(p_decision_note), '')
    where id = p_handover_id
    returning * into v_handover;
    update public.handover_items set is_active = false where handover_id = p_handover_id;
  end if;
  insert into public.audit_logs (actor_id, action, record_type, record_id, metadata)
  values (v_user, case when lower(p_decision) = 'confirm' then 'handover.confirmed' else 'handover.rejected' end, 'handovers', p_handover_id, jsonb_build_object('decision_note', p_decision_note));
  return v_handover;
end;
$$;

create or replace function public.review_payment_correction(p_request_id uuid, p_approve boolean, p_decision_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_request public.payment_correction_requests;
  v_original public.student_payments;
  v_replacement public.student_payments;
  v_replacement_class uuid;
  v_user uuid := auth.uid();
begin
  if v_user is null or not private.has_permission('view_school_reports', v_user) then
    raise exception 'You do not have permission to review corrections';
  end if;
  select * into v_request from public.payment_correction_requests where id = p_request_id for update;
  if v_request.id is null or v_request.status <> 'pending' then
    raise exception 'This correction request is no longer pending';
  end if;
  select * into v_original from public.student_payments where id = v_request.original_payment_id;
  if v_original.id is null then
    raise exception 'Original payment not found';
  end if;
  v_replacement_class := v_original.class_id;
  if p_approve and exists (
    select 1 from public.handover_items hi
    join public.handovers h on h.id = hi.handover_id
    where hi.payment_id = v_original.id and hi.is_active and h.status in ('pending', 'confirmed')
  ) then
    raise exception 'Reject or resolve the active handover before approving this correction';
  end if;

  update public.payment_correction_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      reviewed_by = v_user,
      reviewed_at = now(),
      decision_note = nullif(trim(p_decision_note), '')
  where id = p_request_id;

  insert into public.audit_logs (actor_id, action, record_type, record_id, metadata)
  values (v_user, case when p_approve then 'correction.approved' else 'correction.rejected' end, 'payment_correction_requests', p_request_id, jsonb_build_object('decision_note', p_decision_note));

  if not p_approve then
    return jsonb_build_object('status', 'rejected');
  end if;

  if v_request.action = 'correct' then
    if v_request.requested_student_id is not null then
      select class_id into v_replacement_class
      from public.students
      where id = v_request.requested_student_id;
      if v_replacement_class is null then
        raise exception 'Requested student not found';
      end if;
    end if;
    insert into public.student_payments (
      student_id, class_id, category_id, amount_paid, payment_date, collected_at,
      collector_id, session_id, term_id, note, status, is_correction,
      correction_request_id, origin_payment_id
    )
    values (
      coalesce(v_request.requested_student_id, v_original.student_id),
      v_replacement_class,
      coalesce(v_request.requested_category_id, v_original.category_id),
      v_request.requested_amount,
      coalesce(v_original.payment_date, current_date),
      now(),
      v_original.collector_id,
      coalesce(v_request.requested_session_id, v_original.session_id),
      coalesce(v_request.requested_term_id, v_original.term_id),
      'Correction replacing ' || v_original.reference_no,
      'posted', true, v_request.id, v_original.id
    ) returning * into v_replacement;
  end if;

  insert into public.payment_corrections (
    correction_request_id, original_payment_id, replacement_payment_id,
    action, original_amount, status, approved_by
  ) values (
    v_request.id, v_original.id,
    case when v_request.action = 'correct' then v_replacement.id else null end,
    v_request.action, v_original.amount_paid, 'approved', v_user
  );

  return jsonb_build_object(
    'status', 'approved',
    'replacement_payment_id', case when v_request.action = 'correct' then v_replacement.id else null end
  );
end;
$$;

create or replace function public.record_personal_sale(
  p_product_id uuid,
  p_quantity integer,
  p_unit_price numeric,
  p_note text default null
)
returns public.personal_sales
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_product public.personal_products;
  v_sale public.personal_sales;
begin
  if v_user is null or not private.has_permission('personal_business', v_user) then
    raise exception 'You do not have permission to use Personal Business';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_unit_price is null or p_unit_price < 0 then
    raise exception 'Enter a valid quantity and selling price';
  end if;
  select * into v_product
  from public.personal_products
  where id = p_product_id and active
  for update;
  if v_product.id is null then raise exception 'Product not found'; end if;
  if v_product.quantity < p_quantity then raise exception 'Not enough stock for this sale'; end if;

  insert into public.personal_sales (product_id, quantity, unit_cost, unit_price, note, created_by)
  values (p_product_id, p_quantity, v_product.cost_price, p_unit_price, nullif(trim(p_note), ''), v_user)
  returning * into v_sale;

  update public.personal_products set quantity = quantity - p_quantity where id = p_product_id;
  return v_sale;
end;
$$;

create or replace view public.effective_payment_ledger
with (security_invoker = true)
as
  select p.*
  from public.student_payments p
  where p.status = 'posted'
    and not p.is_correction
    and not exists (
      select 1 from public.payment_corrections pc
      where pc.original_payment_id = p.id and pc.status = 'approved'
    )
  union all
  select p.*
  from public.student_payments p
  where p.status = 'posted'
    and p.is_correction
    and exists (
      select 1 from public.payment_corrections pc
      where pc.replacement_payment_id = p.id and pc.status = 'approved'
    );

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function private.set_updated_at();
drop trigger if exists categories_set_updated_at on public.financial_categories;
create trigger categories_set_updated_at before update on public.financial_categories for each row execute function private.set_updated_at();
drop trigger if exists students_set_updated_at on public.students;
create trigger students_set_updated_at before update on public.students for each row execute function private.set_updated_at();
drop trigger if exists expected_charges_set_updated_at on public.expected_charges;
create trigger expected_charges_set_updated_at before update on public.expected_charges for each row execute function private.set_updated_at();
drop trigger if exists personal_products_set_updated_at on public.personal_products;
create trigger personal_products_set_updated_at before update on public.personal_products for each row execute function private.set_updated_at();
drop trigger if exists payments_validate on public.student_payments;
create trigger payments_validate before insert on public.student_payments for each row execute function private.validate_payment();
drop trigger if exists payments_immutable on public.student_payments;
create trigger payments_immutable before update or delete on public.student_payments for each row execute function private.prevent_payment_mutation();

drop trigger if exists payments_audit_insert on public.student_payments;
create trigger payments_audit_insert after insert on public.student_payments for each row execute function private.audit_insert();
drop trigger if exists correction_requests_audit_insert on public.payment_correction_requests;
create trigger correction_requests_audit_insert after insert on public.payment_correction_requests for each row execute function private.audit_insert();
drop trigger if exists corrections_audit_insert on public.payment_corrections;
create trigger corrections_audit_insert after insert on public.payment_corrections for each row execute function private.audit_insert();
drop trigger if exists handovers_audit_insert on public.handovers;
create trigger handovers_audit_insert after insert on public.handovers for each row execute function private.audit_insert();
drop trigger if exists personal_sales_audit_insert on public.personal_sales;
create trigger personal_sales_audit_insert after insert on public.personal_sales for each row execute function private.audit_insert();
drop trigger if exists personal_expenses_audit_insert on public.personal_expenses;
create trigger personal_expenses_audit_insert after insert on public.personal_expenses for each row execute function private.audit_insert();
drop trigger if exists categories_audit_change on public.financial_categories;
create trigger categories_audit_change after insert or update on public.financial_categories for each row execute function private.audit_change();
drop trigger if exists charges_audit_change on public.expected_charges;
create trigger charges_audit_change after insert or update on public.expected_charges for each row execute function private.audit_change();
drop trigger if exists students_audit_change on public.students;
create trigger students_audit_change after insert or update on public.students for each row execute function private.audit_change();

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.set_updated_at() from public, anon, authenticated;
revoke all on function private.validate_payment() from public, anon, authenticated;
revoke all on function private.prevent_payment_mutation() from public, anon, authenticated;
revoke all on function private.audit_insert() from public, anon, authenticated;
revoke all on function private.audit_change() from public, anon, authenticated;
grant execute on function private.has_permission(text, uuid) to authenticated;
grant execute on function private.is_principal(uuid) to authenticated;
revoke all on function public.create_handover(uuid[]) from public, anon;
grant execute on function public.create_handover(uuid[]) to authenticated;
revoke all on function public.review_handover(uuid, text, text) from public, anon;
grant execute on function public.review_handover(uuid, text, text) to authenticated;
revoke all on function public.review_payment_correction(uuid, boolean, text) from public, anon;
grant execute on function public.review_payment_correction(uuid, boolean, text) to authenticated;
revoke all on function public.record_personal_sale(uuid, integer, numeric, text) from public, anon;
grant execute on function public.record_personal_sale(uuid, integer, numeric, text) to authenticated;

grant usage on schema public to anon, authenticated;
grant usage, select on sequence public.payment_reference_seq to authenticated;
grant select on public.permissions, public.classes, public.academic_sessions, public.terms,
  public.financial_categories, public.financial_category_classes, public.expected_charges to authenticated;
grant insert, update on public.financial_categories to authenticated;
grant insert, delete on public.financial_category_classes to authenticated;
grant insert, update on public.expected_charges to authenticated;
grant select, insert, update on public.students to authenticated;
grant select, insert on public.student_payments to authenticated;
grant select, insert on public.payment_correction_requests to authenticated;
grant select on public.payment_corrections, public.effective_payment_ledger to authenticated;
grant select on public.profiles, public.profile_permissions to authenticated;
grant select on public.handovers, public.handover_items to authenticated;
grant select, insert, update on public.personal_products to authenticated;
grant select on public.personal_sales to authenticated;
grant select, insert on public.personal_expenses to authenticated;
grant select on public.audit_logs to authenticated;

alter table public.profiles enable row level security;
alter table public.permissions enable row level security;
alter table public.profile_permissions enable row level security;
alter table public.classes enable row level security;
alter table public.academic_sessions enable row level security;
alter table public.terms enable row level security;
alter table public.financial_categories enable row level security;
alter table public.financial_category_classes enable row level security;
alter table public.students enable row level security;
alter table public.expected_charges enable row level security;
alter table public.student_payments enable row level security;
alter table public.payment_correction_requests enable row level security;
alter table public.payment_corrections enable row level security;
alter table public.handovers enable row level security;
alter table public.handover_items enable row level security;
alter table public.personal_products enable row level security;
alter table public.personal_sales enable row level security;
alter table public.personal_expenses enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.has_permission('manage_staff'));
create policy permissions_select on public.permissions for select to authenticated
  using (private.has_permission('view_students') or private.has_permission('record_student_payments'));
create policy profile_permissions_select on public.profile_permissions for select to authenticated
  using (profile_id = (select auth.uid()) or private.has_permission('manage_staff'));

create policy classes_select on public.classes for select to authenticated
  using (private.has_permission('view_students') or private.has_permission('record_student_payments') or private.has_permission('view_school_reports'));
create policy sessions_select on public.academic_sessions for select to authenticated
  using (private.has_permission('view_students') or private.has_permission('record_student_payments') or private.has_permission('view_school_reports'));
create policy terms_select on public.terms for select to authenticated
  using (private.has_permission('view_students') or private.has_permission('record_student_payments') or private.has_permission('view_school_reports'));
create policy categories_select on public.financial_categories for select to authenticated
  using (private.has_permission('record_student_payments') or private.has_permission('view_school_reports') or private.has_permission('manage_financial_categories'));
create policy categories_insert on public.financial_categories for insert to authenticated
  with check (private.has_permission('manage_financial_categories'));
create policy categories_update on public.financial_categories for update to authenticated
  using (private.has_permission('manage_financial_categories'))
  with check (private.has_permission('manage_financial_categories'));
create policy category_classes_select on public.financial_category_classes for select to authenticated
  using (private.has_permission('record_student_payments') or private.has_permission('view_school_reports') or private.has_permission('manage_financial_categories'));
create policy category_classes_insert on public.financial_category_classes for insert to authenticated
  with check (private.has_permission('manage_financial_categories'));
create policy category_classes_delete on public.financial_category_classes for delete to authenticated
  using (private.has_permission('manage_financial_categories'));

create policy students_select on public.students for select to authenticated
  using (private.has_permission('view_students') or private.has_permission('record_student_payments') or private.has_permission('view_school_reports'));
create policy students_insert on public.students for insert to authenticated
  with check (private.has_permission('manage_students'));
create policy students_update on public.students for update to authenticated
  using (private.has_permission('manage_students'))
  with check (private.has_permission('manage_students'));

create policy expected_charges_select on public.expected_charges for select to authenticated
  using (private.has_permission('view_school_reports') or private.has_permission('view_students'));
create policy expected_charges_insert on public.expected_charges for insert to authenticated
  with check (private.has_permission('manage_financial_categories'));
create policy expected_charges_update on public.expected_charges for update to authenticated
  using (private.has_permission('manage_financial_categories'))
  with check (private.has_permission('manage_financial_categories'));

create policy payments_select on public.student_payments for select to authenticated
  using (
    private.has_permission('view_all_collections')
    or private.has_permission('view_school_reports')
    or (collector_id = (select auth.uid()) and (private.has_permission('view_own_collections') or private.has_permission('record_student_payments')))
  );
create policy payments_insert on public.student_payments for insert to authenticated
  with check (
    collector_id = (select auth.uid())
    and private.has_permission('record_student_payments')
    and status = 'posted'
    and not is_correction
  );

create policy correction_requests_select on public.payment_correction_requests for select to authenticated
  using (
    requested_by = (select auth.uid())
    or private.has_permission('view_all_collections')
    or private.has_permission('view_school_reports')
  );
create policy correction_requests_insert on public.payment_correction_requests for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and private.has_permission('record_student_payments')
    and status = 'pending'
    and exists (
      select 1 from public.student_payments p
      where p.id = original_payment_id and p.collector_id = (select auth.uid())
    )
  );

create policy payment_corrections_select on public.payment_corrections for select to authenticated
  using (
    private.has_permission('view_school_reports')
    or private.has_permission('view_all_collections')
    or exists (
      select 1 from public.student_payments p
      where p.id = original_payment_id and p.collector_id = (select auth.uid())
    )
  );

create policy handovers_select on public.handovers for select to authenticated
  using (
    staff_id = (select auth.uid())
    or private.has_permission('view_all_collections')
    or private.has_permission('view_school_reports')
    or private.has_permission('confirm_handovers')
  );
create policy handover_items_select on public.handover_items for select to authenticated
  using (
    exists (
      select 1 from public.handovers h
      where h.id = handover_id
        and (
          h.staff_id = (select auth.uid())
          or private.has_permission('view_all_collections')
          or private.has_permission('view_school_reports')
          or private.has_permission('confirm_handovers')
        )
    )
  );

create policy personal_products_select on public.personal_products for select to authenticated
  using (private.has_permission('personal_business'));
create policy personal_products_insert on public.personal_products for insert to authenticated
  with check (private.has_permission('personal_business'));
create policy personal_products_update on public.personal_products for update to authenticated
  using (private.has_permission('personal_business'))
  with check (private.has_permission('personal_business'));
create policy personal_sales_select on public.personal_sales for select to authenticated
  using (private.has_permission('personal_business'));
create policy personal_expenses_select on public.personal_expenses for select to authenticated
  using (private.has_permission('personal_business'));
create policy personal_expenses_insert on public.personal_expenses for insert to authenticated
  with check (private.has_permission('personal_business') and created_by = (select auth.uid()));

create policy audit_select on public.audit_logs for select to authenticated
  using (private.has_permission('view_school_reports') or private.is_principal());

grant select on public.effective_payment_ledger to authenticated;

commit;
