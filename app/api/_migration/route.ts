import { NextResponse } from "next/server";
import { Client } from "pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USERNAME = "ilawo-migrate-8b2e4c7a";
const HOST = "aws-0-eu-west-2.pooler.supabase.com";
const DB_USER = "postgres.swqvzqncjszzifzrjmcc";
const MIGRATIONS = [
  "202609020002_principal_record_book.sql",
  "202609020003_external_exam_candidates.sql",
  "202609050004_candidate_scope_and_student_register.sql",
];

function readBasic(request: Request) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (split < 0) return null;
    return { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = readBasic(request);
  if (!auth || auth.username !== USERNAME || !auth.password) {
    return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Ilawo migration"', "cache-control": "no-store" } });
  }

  const db = new Client({
    host: HOST,
    port: 5432,
    database: "postgres",
    user: DB_USER,
    password: auth.password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  try {
    await db.connect();
    const applied: string[] = [];
    for (const file of MIGRATIONS) {
      const url = `https://raw.githubusercontent.com/alabykhan-lang/Ilawo-Financial-Portal-/main/supabase/migrations/${file}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not download ${file}: HTTP ${response.status}`);
      const sql = await response.text();
      await db.query(sql);
      applied.push(file);
    }

    const tables = await db.query(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('portal_settings','school_expenses','category_candidates','external_candidates','external_candidate_payments','students','financial_categories')
      order by table_name
    `);
    const columns = await db.query(`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and ((table_name='students' and column_name in ('guardian_name','guardian_phone','guardian_email'))
          or (table_name='financial_categories' and column_name in ('basis','candidate_scope')))
      order by table_name, column_name
    `);
    const categories = await db.query(`
      select name, basis, candidate_scope, active
      from public.financial_categories
      where active
      order by name
    `);

    return NextResponse.json({ ok: true, applied, verified_tables: tables.rows, verified_columns: columns.rows, categories: categories.rows }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Ilawo migration failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Migration failed" }, { status: 500, headers: { "cache-control": "no-store" } });
  } finally {
    await db.end().catch(() => undefined);
  }
}
