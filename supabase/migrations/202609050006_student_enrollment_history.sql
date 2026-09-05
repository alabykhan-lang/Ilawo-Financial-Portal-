begin;

-- Preserve class/session movement without changing historical payment records.
-- The students table remains the current master register; this table is the
-- immutable history of where each internal student was placed over time.
create table if not exists public.student_enrollment_history (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete restrict,
  from_class_id uuid references public.classes(id) on delete restrict,
  to_class_id uuid references public.classes(id) on delete restrict,
  from_session_id uuid references public.academic_sessions(id) on delete restrict,
  to_session_id uuid references public.academic_sessions(id) on delete restrict,
  change_type text not null check (change_type in ('created','class_change','session_change','promotion')),
  changed_by uuid references public.profiles(id) on delete restrict,
  changed_at timestamptz not null default now(),
  note text
);

create index if not exists student_enrollment_history_student_idx
  on public.student_enrollment_history(student_id, changed_at desc);
create index if not exists student_enrollment_history_period_idx
  on public.student_enrollment_history(to_session_id, to_class_id, changed_at desc);

create or replace function private.capture_student_enrollment_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text;
  v_actor uuid;
begin
  v_actor := coalesce(auth.uid(), new.created_by);

  if tg_op = 'INSERT' then
    insert into public.student_enrollment_history(
      student_id, to_class_id, to_session_id, change_type, changed_by
    ) values (
      new.id, new.class_id, new.academic_session_id, 'created', v_actor
    );
    return new;
  end if;

  if old.class_id is not distinct from new.class_id
     and old.academic_session_id is not distinct from new.academic_session_id then
    return new;
  end if;

  if old.academic_session_id is distinct from new.academic_session_id
     and old.class_id is distinct from new.class_id then
    v_type := 'promotion';
  elsif old.academic_session_id is distinct from new.academic_session_id then
    v_type := 'session_change';
  else
    v_type := 'class_change';
  end if;

  insert into public.student_enrollment_history(
    student_id,
    from_class_id,
    to_class_id,
    from_session_id,
    to_session_id,
    change_type,
    changed_by
  ) values (
    new.id,
    old.class_id,
    new.class_id,
    old.academic_session_id,
    new.academic_session_id,
    v_type,
    v_actor
  );

  return new;
end;
$$;

create or replace function private.prevent_enrollment_history_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'Student enrollment history is immutable.';
end;
$$;

drop trigger if exists students_enrollment_history on public.students;
create trigger students_enrollment_history
after insert or update of class_id, academic_session_id on public.students
for each row execute function private.capture_student_enrollment_history();

drop trigger if exists student_enrollment_history_immutable on public.student_enrollment_history;
create trigger student_enrollment_history_immutable
before update or delete on public.student_enrollment_history
for each row execute function private.prevent_enrollment_history_mutation();

alter table public.student_enrollment_history enable row level security;
drop policy if exists student_enrollment_history_select on public.student_enrollment_history;
create policy student_enrollment_history_select
on public.student_enrollment_history
for select to authenticated
using (private.is_principal());

grant select on public.student_enrollment_history to authenticated;
revoke insert, update, delete on public.student_enrollment_history from authenticated;
revoke all on function private.capture_student_enrollment_history() from public, anon, authenticated;
revoke all on function private.prevent_enrollment_history_mutation() from public, anon, authenticated;

-- Backfill one baseline row for existing students that have no captured history.
insert into public.student_enrollment_history(
  student_id, to_class_id, to_session_id, change_type, changed_by, note
)
select s.id, s.class_id, s.academic_session_id, 'created', s.created_by, 'Baseline captured when enrollment history was enabled.'
from public.students s
where not exists (
  select 1 from public.student_enrollment_history h where h.student_id = s.id
);

-- Realtime is optional at the database level, but when available expose the
-- immutable history so future Principal views can update without a reload.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'student_enrollment_history'
     ) then
    alter publication supabase_realtime add table public.student_enrollment_history;
  end if;
end $$;

commit;
