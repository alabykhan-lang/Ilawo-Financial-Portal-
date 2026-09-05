import type { SupabaseClient } from "@supabase/supabase-js";
import { CommandCenterError } from "@/lib/command-center";

type AnyClient = SupabaseClient<any>;
type R = Record<string, any>;

export const EXTENDED_COMMAND_TOOLS = [
  {
    name: "record_internal_payments_batch",
    description: "Record several internal-student payments in one reviewed batch. Useful after ChatGPT reads a handwritten payment sheet. WAEC/NECO students must already be registered as internal exam candidates.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        payment_date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        note: { type: "string" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            properties: {
              admission_no: { type: "string" },
              amount: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["admission_no", "amount"],
          },
        },
      },
      required: ["category", "items"],
    },
  },
  {
    name: "record_external_payments_batch",
    description: "Record several WAEC or NECO external-candidate payments in one reviewed batch. Candidate names must already exist under the selected exam.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["WAEC", "NECO"] },
        payment_date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        note: { type: "string" },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            properties: {
              candidate_name: { type: "string" },
              amount: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["candidate_name", "amount"],
          },
        },
      },
      required: ["category", "items"],
    },
  },
  {
    name: "promote_class",
    description: "Move all active internal students in one class to another class/session. This is a major register change and requires confirm=true. Existing historical payment records keep their original class/session.",
    inputSchema: {
      type: "object",
      properties: {
        from_class: { type: "string" },
        to_class: { type: "string" },
        target_session: { type: "string" },
        confirm: { type: "boolean", description: "Must be true after the Principal confirms the promotion." },
      },
      required: ["from_class", "to_class", "target_session", "confirm"],
    },
  },
] as const;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function category(client: AnyClient, value: string) {
  const aliases = String(value || "").toUpperCase() === "U.P.E" ? ["U.P.E", "JUPEB"] : [String(value || "").trim()];
  for (const name of aliases) {
    const { data } = await client.from("financial_categories").select("*").ilike("name", name).eq("active", true).limit(1).maybeSingle();
    if (data) return data;
  }
  throw new CommandCenterError(`Category '${value}' was not found.`);
}

function mixed(c: R) {
  return c.candidate_scope ? c.candidate_scope === "mixed" : ["WAEC", "NECO"].includes(String(c.name).toUpperCase());
}

async function period(client: AnyClient) {
  const { data: settings } = await client.from("portal_settings").select("*").eq("id", 1).maybeSingle();
  const { data: session } = settings?.current_session_id
    ? await client.from("academic_sessions").select("*").eq("id", settings.current_session_id).maybeSingle()
    : await client.from("academic_sessions").select("*").eq("active", true).eq("is_test", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!session) throw new CommandCenterError("No current academic session is configured.");
  const { data: term } = settings?.current_term_id
    ? await client.from("terms").select("*").eq("id", settings.current_term_id).maybeSingle()
    : await client.from("terms").select("*").eq("session_id", session.id).eq("active", true).order("display_order").limit(1).maybeSingle();
  return { session, term };
}

export async function executeExtendedCommandTool(client: AnyClient, name: string, args: Record<string, any>) {
  if (name === "record_internal_payments_batch") {
    const p = await period(client);
    const c = await category(client, args.category);
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length || items.length > 200) throw new CommandCenterError("Batch must contain between 1 and 200 payments.");
    const admissions = [...new Set(items.map((x: any) => String(x.admission_no || "").trim()).filter(Boolean))];
    const { data: students, error } = await client.from("students").select("id,admission_no,full_name,class_id,academic_session_id").in("admission_no", admissions);
    if (error) throw new CommandCenterError(error.message);
    const byAdmission = new Map((students || []).map((s: R) => [s.admission_no, s]));
    const missing = admissions.filter((x) => !byAdmission.has(x));
    if (missing.length) throw new CommandCenterError(`These admission numbers were not found: ${missing.join(", ")}`);
    let registered = new Set<string>();
    if (mixed(c)) {
      const { data } = await client.from("category_candidates").select("student_id").eq("category_id", c.id).eq("session_id", p.session.id);
      registered = new Set((data || []).map((r: R) => r.student_id));
    }
    const rows = items.map((item: any) => {
      const s = byAdmission.get(String(item.admission_no).trim()) as R;
      if (s.academic_session_id !== p.session.id) throw new CommandCenterError(`${s.full_name} is not in the current session.`);
      if (mixed(c) && !registered.has(s.id)) throw new CommandCenterError(`${s.full_name} is not registered as an internal ${c.name} candidate.`);
      const amount = Number(item.amount);
      if (!(amount > 0)) throw new CommandCenterError(`Invalid amount for ${s.full_name}.`);
      return {
        student_id: s.id,
        class_id: s.class_id,
        category_id: c.id,
        amount_paid: amount,
        payment_date: args.payment_date || today(),
        session_id: p.session.id,
        term_id: c.basis === "term" || c.applicable_to_term ? p.term?.id || null : null,
        note: args.note || null,
      };
    });
    const { data, error: writeError } = await client.from("student_payments").insert(rows).select("id,reference_no,student_id,amount_paid,payment_date");
    if (writeError) throw new CommandCenterError(writeError.message);
    return { ok: true, message: `${data?.length || rows.length} internal payments recorded and protected.`, category: c.name, count: data?.length || rows.length, total: rows.reduce((a: number, r: R) => a + r.amount_paid, 0) };
  }

  if (name === "record_external_payments_batch") {
    const p = await period(client);
    const c = await category(client, args.category);
    if (!mixed(c) || !["WAEC", "NECO"].includes(String(c.name).toUpperCase())) throw new CommandCenterError("External candidates are only allowed for WAEC and NECO.");
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length || items.length > 200) throw new CommandCenterError("Batch must contain between 1 and 200 payments.");
    const { data: candidates, error } = await client.from("external_candidates").select("id,full_name").eq("category_id", c.id).eq("session_id", p.session.id).eq("active", true);
    if (error) throw new CommandCenterError(error.message);
    const groups = new Map<string, R[]>();
    for (const candidate of candidates || []) {
      const key = String(candidate.full_name).trim().toLowerCase();
      groups.set(key, [...(groups.get(key) || []), candidate]);
    }
    const rows = items.map((item: any) => {
      const key = String(item.candidate_name || "").trim().toLowerCase();
      const matches = groups.get(key) || [];
      if (!matches.length) throw new CommandCenterError(`External candidate '${item.candidate_name}' was not found.`);
      if (matches.length > 1) throw new CommandCenterError(`More than one external candidate is named '${item.candidate_name}'. Record that candidate through the portal to disambiguate.`);
      const amount = Number(item.amount);
      if (!(amount > 0)) throw new CommandCenterError(`Invalid amount for ${item.candidate_name}.`);
      return {
        external_candidate_id: matches[0].id,
        category_id: c.id,
        amount_paid: amount,
        payment_date: args.payment_date || today(),
        session_id: p.session.id,
        note: args.note || null,
      };
    });
    const { data, error: writeError } = await client.from("external_candidate_payments").insert(rows).select("id,reference_no,external_candidate_id,amount_paid,payment_date");
    if (writeError) throw new CommandCenterError(writeError.message);
    return { ok: true, message: `${data?.length || rows.length} external payments recorded and protected.`, category: c.name, count: data?.length || rows.length, total: rows.reduce((a: number, r: R) => a + r.amount_paid, 0) };
  }

  if (name === "promote_class") {
    if (args.confirm !== true) throw new CommandCenterError("Promotion was not executed because confirm=true was not supplied after Principal review.");
    const { data: from } = await client.from("classes").select("id,name").ilike("name", String(args.from_class || "").trim()).eq("active", true).maybeSingle();
    const { data: to } = await client.from("classes").select("id,name").ilike("name", String(args.to_class || "").trim()).eq("active", true).maybeSingle();
    const { data: targetSession } = await client.from("academic_sessions").select("id,name").ilike("name", String(args.target_session || "").trim()).eq("is_test", false).maybeSingle();
    if (!from || !to || !targetSession) throw new CommandCenterError("From class, to class or target session could not be resolved.");
    const current = await period(client);
    const { data: students, error } = await client.from("students").select("id,full_name,admission_no").eq("class_id", from.id).eq("academic_session_id", current.session.id).eq("status", "active");
    if (error) throw new CommandCenterError(error.message);
    if (!students?.length) return { ok: true, message: "No active students needed promotion.", count: 0 };
    const ids = students.map((s: R) => s.id);
    const { error: updateError } = await client.from("students").update({ class_id: to.id, academic_session_id: targetSession.id }).in("id", ids);
    if (updateError) throw new CommandCenterError(updateError.message);
    return { ok: true, message: `${ids.length} students promoted. Historical payment records were not changed.`, count: ids.length, from_class: from.name, to_class: to.name, target_session: targetSession.name };
  }

  throw new CommandCenterError(`Unknown extended command-center tool '${name}'.`, 404);
}
