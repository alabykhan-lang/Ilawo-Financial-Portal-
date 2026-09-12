-- Remove the unused admission number field from the student register.
-- This forward migration preserves the original migration history while aligning
-- the live schema with the current student model.
begin;

alter table public.students
  drop constraint if exists students_admission_no_key;

alter table public.students
  drop column if exists admission_no;

commit;
