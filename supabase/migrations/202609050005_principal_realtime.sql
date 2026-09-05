begin;

-- Keep the Principal portal synchronized with records written from another
-- authenticated client such as the Principal's connected ChatGPT/Supabase
-- session. This migration is idempotent and should run after 002-004.
do $$
declare
  t text;
  live_tables text[] := array[
    'portal_settings',
    'students',
    'academic_sessions',
    'terms',
    'classes',
    'financial_categories',
    'financial_category_classes',
    'expected_charges',
    'student_payments',
    'payment_correction_requests',
    'payment_corrections',
    'category_candidates',
    'external_candidates',
    'external_candidate_payments',
    'school_expenses',
    'personal_products',
    'personal_sales',
    'personal_expenses'
  ];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  foreach t in array live_tables loop
    if to_regclass('public.' || t) is not null
       and not exists (
         select 1
         from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = t
       ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

commit;
