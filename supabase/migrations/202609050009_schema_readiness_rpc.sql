begin;

-- Expose only structural readiness booleans. This lets the public health route verify
-- that the migration chain is live without granting anon access to financial records.
create or replace function public.financial_portal_schema_readiness()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings boolean;
  v_expenses boolean;
  v_internal_candidates boolean;
  v_external_candidates boolean;
  v_external_payments boolean;
  v_enrollment_history boolean;
  v_category_basis boolean;
  v_candidate_scope boolean;
  v_guardian_phone boolean;
  v_expense_corrections boolean;
  v_external_corrections boolean;
  v_effective_expenses boolean;
  v_effective_external boolean;
  v_correction_functions boolean;
  v_ready boolean;
begin
  v_settings := to_regclass('public.portal_settings') is not null;
  v_expenses := to_regclass('public.school_expenses') is not null;
  v_internal_candidates := to_regclass('public.category_candidates') is not null;
  v_external_candidates := to_regclass('public.external_candidates') is not null;
  v_external_payments := to_regclass('public.external_candidate_payments') is not null;
  v_enrollment_history := to_regclass('public.student_enrollment_history') is not null;
  v_expense_corrections := to_regclass('public.school_expense_corrections') is not null;
  v_external_corrections := to_regclass('public.external_payment_corrections') is not null;
  v_effective_expenses := to_regclass('public.effective_school_expense_ledger') is not null;
  v_effective_external := to_regclass('public.effective_external_candidate_payment_ledger') is not null;

  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='financial_categories' and column_name='basis'
  ) into v_category_basis;
  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='financial_categories' and column_name='candidate_scope'
  ) into v_candidate_scope;
  select exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='students' and column_name='guardian_phone'
  ) into v_guardian_phone;

  v_correction_functions :=
    to_regprocedure('public.principal_correct_payment(uuid,text,numeric,text)') is not null
    and to_regprocedure('public.principal_correct_expense(uuid,text,numeric,text)') is not null
    and to_regprocedure('public.principal_correct_external_payment(uuid,text,numeric,text)') is not null;

  v_ready :=
    v_settings and v_expenses and v_internal_candidates and v_external_candidates
    and v_external_payments and v_enrollment_history and v_category_basis
    and v_candidate_scope and v_guardian_phone and v_expense_corrections
    and v_external_corrections and v_effective_expenses and v_effective_external
    and v_correction_functions;

  return jsonb_build_object(
    'ready', v_ready,
    'checks', jsonb_build_object(
      'settings', jsonb_build_object('ready',v_settings),
      'expenses', jsonb_build_object('ready',v_expenses),
      'internalCandidates', jsonb_build_object('ready',v_internal_candidates),
      'externalCandidates', jsonb_build_object('ready',v_external_candidates),
      'externalPayments', jsonb_build_object('ready',v_external_payments),
      'enrollmentHistory', jsonb_build_object('ready',v_enrollment_history),
      'categoryBasis', jsonb_build_object('ready',v_category_basis),
      'candidateScope', jsonb_build_object('ready',v_candidate_scope),
      'guardianPhone', jsonb_build_object('ready',v_guardian_phone),
      'expenseCorrections', jsonb_build_object('ready',v_expense_corrections),
      'externalPaymentCorrections', jsonb_build_object('ready',v_external_corrections),
      'effectiveExpenseLedger', jsonb_build_object('ready',v_effective_expenses),
      'effectiveExternalPaymentLedger', jsonb_build_object('ready',v_effective_external),
      'correctionFunctions', jsonb_build_object('ready',v_correction_functions)
    )
  );
end;
$$;

revoke all on function public.financial_portal_schema_readiness() from public;
grant execute on function public.financial_portal_schema_readiness() to anon, authenticated;

commit;
