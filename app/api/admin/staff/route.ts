import { NextResponse } from "next/server";
import { getAdminSupabase, getServerSupabase } from "@/lib/server";

export const runtime = "nodejs";

async function getPrincipal() {
  const server = await getServerSupabase();
  const { data: authData, error: authError } = await server.auth.getUser();
  if (authError || !authData.user) return { server, user: null, profile: null };

  const { data: profile } = await server
    .from("profiles")
    .select("id,full_name,email,role,active,staff_code")
    .eq("id", authData.user.id)
    .single();
  if (!profile || profile.role !== "principal" || !profile.active) return { server, user: null, profile: null };
  return { server, user: authData.user, profile };
}

export async function POST(request: Request) {
  try {
    const { user } = await getPrincipal();
    if (!user) return NextResponse.json({ error: "Principal access is required." }, { status: 403 });

    const body = await request.json();
    const action = String(body.action || "create");
    const admin = getAdminSupabase();

    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const fullName = String(body.fullName || "").trim();
      const permissions = Array.isArray(body.permissions) ? body.permissions.map(String) : [];
      if (!email.includes("@") || password.length < 8 || fullName.length < 2) {
        return NextResponse.json({ error: "Enter a valid name, email and temporary password of at least 8 characters." }, { status: 400 });
      }

      const { data: created, error: userError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });
      if (userError || !created.user) throw userError || new Error("Staff account could not be created.");

      const staffCode = `ILW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const { error: profileError } = await admin.from("profiles").upsert({
        id: created.user.id,
        full_name: fullName,
        email,
        role: "staff",
        active: true,
        staff_code: staffCode,
      });
      if (profileError) {
        await admin.auth.admin.deleteUser(created.user.id);
        throw profileError;
      }

      const { data: validPermissions } = await admin.from("permissions").select("key").in("key", permissions);
      if (validPermissions?.length) {
        const { error: permissionError } = await admin.from("profile_permissions").insert(
          validPermissions.map((permission) => ({ profile_id: created.user!.id, permission_key: permission.key })),
        );
        if (permissionError) throw permissionError;
      }

      await admin.from("audit_logs").insert({
        actor_id: user.id,
        action: "staff.created",
        record_type: "profiles",
        record_id: created.user.id,
        metadata: { email, permissions: validPermissions?.map((permission) => permission.key) || [] },
      });

      return NextResponse.json({ ok: true, staffCode, userId: created.user.id }, { status: 201 });
    }

    const targetId = String(body.userId || "");
    if (!targetId) return NextResponse.json({ error: "A staff account was not selected." }, { status: 400 });
    const { data: target } = await admin.from("profiles").select("id,role,full_name,active").eq("id", targetId).single();
    if (!target || target.role !== "staff") return NextResponse.json({ error: "Only staff accounts can be changed here." }, { status: 400 });

    if (action === "toggle") {
      const active = Boolean(body.active);
      const { error } = await admin.from("profiles").update({ active }).eq("id", targetId);
      if (error) throw error;
      await admin.from("audit_logs").insert({
        actor_id: user.id,
        action: active ? "staff.enabled" : "staff.disabled",
        record_type: "profiles",
        record_id: targetId,
        metadata: { full_name: target.full_name },
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "reset-password") {
      const password = String(body.password || "");
      if (password.length < 8) return NextResponse.json({ error: "Use a password of at least 8 characters." }, { status: 400 });
      const { error } = await admin.auth.admin.updateUserById(targetId, { password });
      if (error) throw error;
      await admin.from("audit_logs").insert({
        actor_id: user.id,
        action: "staff.credentials_reset",
        record_type: "profiles",
        record_id: targetId,
        metadata: {},
      });
      return NextResponse.json({ ok: true });
    }

    if (action === "permissions") {
      const permissions = Array.isArray(body.permissions) ? body.permissions.map(String) : [];
      const { data: validPermissions } = await admin.from("permissions").select("key").in("key", permissions);
      const { error: deleteError } = await admin.from("profile_permissions").delete().eq("profile_id", targetId);
      if (deleteError) throw deleteError;
      if (validPermissions?.length) {
        const { error: insertError } = await admin.from("profile_permissions").insert(
          validPermissions.map((permission) => ({ profile_id: targetId, permission_key: permission.key })),
        );
        if (insertError) throw insertError;
      }
      await admin.from("audit_logs").insert({
        actor_id: user.id,
        action: "staff.permissions_changed",
        record_type: "profile_permissions",
        record_id: targetId,
        metadata: { permissions: validPermissions?.map((permission) => permission.key) || [] },
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown staff action." }, { status: 400 });
  } catch (error) {
    console.error("Staff admin error", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Staff action could not be completed." }, { status: 500 });
  }
}
