import { NextResponse } from "next/server";
import { getAdminSupabase } from "@/lib/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.fullName || "").trim();
    const secret = String(body.secret || "");

    if (!process.env.BOOTSTRAP_SECRET || secret !== process.env.BOOTSTRAP_SECRET) {
      return NextResponse.json({ error: "The bootstrap secret is not correct." }, { status: 403 });
    }
    if (!email || !email.includes("@") || password.length < 8 || fullName.length < 2) {
      return NextResponse.json({ error: "Enter a valid name, email and password of at least 8 characters." }, { status: 400 });
    }

    const admin = getAdminSupabase();
    const { data: existingPrincipal, error: lookupError } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "principal")
      .eq("active", true)
      .limit(1);

    if (lookupError) throw lookupError;
    if (existingPrincipal && existingPrincipal.length > 0) {
      return NextResponse.json({ error: "A principal already exists. Use the normal login." }, { status: 409 });
    }

    const { data: created, error: userError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (userError || !created.user) throw userError || new Error("The principal account could not be created.");

    const { error: profileError } = await admin.from("profiles").upsert({
      id: created.user.id,
      full_name: fullName,
      email,
      role: "principal",
      active: true,
      staff_code: "PRINCIPAL",
    });
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      throw profileError;
    }

    const { data: permissionRows } = await admin.from("permissions").select("key");
    if (permissionRows?.length) {
      await admin.from("profile_permissions").upsert(
        permissionRows.map((permission) => ({ profile_id: created.user!.id, permission_key: permission.key })),
        { onConflict: "profile_id,permission_key" },
      );
    }

    await admin.from("audit_logs").insert({
      actor_id: created.user.id,
      action: "principal.bootstrap",
      record_type: "profiles",
      record_id: created.user.id,
      metadata: { email, method: "one-time-bootstrap" },
    });

    return NextResponse.json({ ok: true, message: "Principal account created. You can now sign in." }, { status: 201 });
  } catch (error) {
    console.error("Bootstrap error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Bootstrap could not be completed." }, { status: 500 });
  }
}
