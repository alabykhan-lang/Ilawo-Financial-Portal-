import { NextResponse } from "next/server";
import { ILAWO_SUPABASE_URL } from "@/lib/public-supabase-config";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    resource: "https://ilawo-financial-portal.vercel.app/api/mcp",
    authorization_servers: [`${ILAWO_SUPABASE_URL}/auth/v1`],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://ilawo-financial-portal.vercel.app",
  });
}
