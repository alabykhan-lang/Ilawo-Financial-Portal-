import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    configured: {
      database_url: Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL),
      service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      bootstrap_secret: Boolean(process.env.BOOTSTRAP_SECRET),
      public_supabase_url: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL),
      public_supabase_key: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    },
  }, { headers: { "cache-control": "no-store" } });
}
