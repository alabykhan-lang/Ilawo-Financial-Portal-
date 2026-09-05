import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseConfig } from "@/lib/public-supabase-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { url, key } = getPublicSupabaseConfig();
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  async function table(name: string) {
    const { error } = await client.from(name).select("id").limit(1);
    return { ready: !error, error: error?.code || null };
  }

  async function column(tableName: string, columnName: string) {
    const { error } = await client.from(tableName).select(columnName).limit(1);
    return { ready: !error, error: error?.code || null };
  }

  const [
    settings,
    expenses,
    internalCandidates,
    externalCandidates,
    externalPayments,
    enrollmentHistory,
    categoryBasis,
    candidateScope,
    guardianPhone,
  ] = await Promise.all([
    table("portal_settings"),
    table("school_expenses"),
    table("category_candidates"),
    table("external_candidates"),
    table("external_candidate_payments"),
    table("student_enrollment_history"),
    column("financial_categories", "basis"),
    column("financial_categories", "candidate_scope"),
    column("students", "guardian_phone"),
  ]);

  const checks = {
    settings,
    expenses,
    internalCandidates,
    externalCandidates,
    externalPayments,
    enrollmentHistory,
    categoryBasis,
    candidateScope,
    guardianPhone,
  };
  const ready = Object.values(checks).every((x) => x.ready);

  return NextResponse.json(
    { ok: true, ready, checks },
    { headers: { "cache-control": "no-store" } },
  );
}
