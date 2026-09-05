import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPublicSupabaseConfig } from "@/lib/public-supabase-config";

type AnyClient = SupabaseClient<any>;
type Row = Record<string, any>;

export class CommandCenterError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const COMMAND_TOOLS = [
  {
    name: "get_financial_summary",
    description: "Get the Principal's current school financial summary with collection, expenses, net balance and category breakdown.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_category_report",
    description: "Get detailed financial and registration information for one category such as School Fees, WAEC, NECO, BECE or U.P.E.",
    inputSchema: {
      type: "object",
      properties: { category: { type: "string", description: "Financial category name" } },
      required: ["category"],
    },
  },
  {
    name: "list_students",
    description: "List internal school students from the master register, optionally filtered by class or search text.",
    inputSchema: {
      type: "object",
      properties: {
        class_name: { type: "string", description: "Optional class, e.g. SS3" },
        search: { type: "string", description: "Optional name, admission number or guardian phone search" },
      },
    },
  },
  {
    name: "record_internal_payment",
    description: "Record a protected payment for an internal Ilawo student. For WAEC/NECO the student must already be registered as an internal exam candidate.",
    inputSchema: {
      type: "object",
      properties: {
        admission_no: { type: "string" },
        category: { type: "string" },
        amount: { type: "number", exclusiveMinimum: 0 },
        payment_date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        note: { type: "string" },
      },
      required: ["admission_no", "category", "amount"],
    },
  },
  {
    name: "add_external_candidate",
    description: "Add an external candidate. External candidates are allowed only for WAEC and NECO and never enter the internal school register.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["WAEC", "NECO"] },
        full_name: { type: "string" },
        class_level: { type: "string", enum: ["SS2", "SS3", "Other"] },
        expected_amount: { type: "number", minimum: 0 },
        phone: { type: "string" },
        source_school: { type: "string" },
      },
      required: ["category", "full_name"],
    },
  },
  {
    name: "record_external_payment",
    description: "Record a protected payment for an already-created WAEC or NECO external candidate.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["WAEC", "NECO"] },
        candidate_name: { type: "string" },
        amount: { type: "number", exclusiveMinimum: 0 },
        payment_date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        note: { type: "string" },
      },
      required: ["category", "candidate_name", "amount"],
    },
  },
  {
    name: "record_expense",
    description: "Record a protected school expense against the correct collection/fund so category net balance is calculated correctly.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        amount: { type: "number", exclusiveMinimum: 0 },
        expense_type: { type: "string", description: "e.g. Registration / Remittance, Logistics / Transport, Printing" },
        description: { type: "string" },
        expense_date: { type: "string", description: "YYYY-MM-DD; defaults to today" },
        note: { type: "string" },
      },
      required: ["category", "amount", "expense_type"],
    },
  },
  {
    name: "add_student",
    description: "Add an internal student to the Principal's master school register with optional guardian details.",
    inputSchema: {
      type: "object",
      properties: {
        admission_no: { type: "string" },
        full_name: { type: "string" },
        class_name: { type: "string" },
        arm: { type: "string" },
        guardian_name: { type: "string" },
        guardian_phone: { type: "string" },
        guardian_email: { type: "string" },
      },
      required: ["admission_no", "full_name", "class_name"],
    },
  },
  {
    name: "set_current_period",
    description: "Change the current academic session and term used automatically for new records. Historical records are not changed.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "e.g. 2026/2027" },
        term: { type: "string", enum: ["First Term", "Second Term", "Third Term"] },
      },
      required: ["session"],
    },
  },
  {
    name: "set_expected_charge",
    description: "Set the expected amount for an internal class under a category for the current period.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        class_name: { type: "string" },
        amount: { type: "number", minimum: 0 },
      },
      required: ["category", "class_name", "amount"],
    },
  },
  {
    name: "set_internal_exam_registration",
    description: "Register or unregister an internal Ilawo student as a WAEC/NECO candidate for the current session.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["WAEC", "NECO"] },
        admission_no: { type: "string" },
        registered: { type: "boolean" },
        expected_amount_override: { type: "number", minimum: 0 },
      },
      required: ["category", "admission_no", "registered"],
    },
  },
] as const;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function basis(category: Row) {
  return category.basis || (category.applicable_to_term ? "term" : "session");
}

function scope(category: Row) {
  if (category.candidate_scope) return category.candidate_scope;
  return ["WAEC", "NECO"].includes(String(category.name || "").toUpperCase()) ? "mixed" : "internal_only";
}

function displayName(category: Row) {
  return String(category.name || "").toUpperCase() === "JUPEB" ? "U.P.E" : String(category.name || "");
}

async function must<T>(promise: PromiseLike<{ data: T; error: any }>, context: string): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new CommandCenterError(`${context}: ${error.message}`);
  return data;
}

export async function authenticatePrincipal(request: Request) {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new CommandCenterError("Sign in to Ilawo Financial Portal to use the command center.", 401);
  const token = match[1];
  const { url, key } = getPublicSupabaseConfig();
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) throw new CommandCenterError("Your Ilawo session is not valid. Sign in again.", 401);
  const { data: profile, error: profileError } = await client.from("profiles").select("id,full_name,email,role,active").eq("id", userData.user.id).single();
  if (profileError || !profile) throw new CommandCenterError("Principal profile could not be verified.", 403);
  if (!profile.active || profile.role !== "principal") throw new CommandCenterError("Only the Principal account can use this command center.", 403);
  return { client, profile, token };
}

async function currentPeriod(client: AnyClient) {
  const { data: settings } = await client.from("portal_settings").select("*").eq("id", 1).maybeSingle();
  let session: Row | null = null;
  let term: Row | null = null;
  if (settings?.current_session_id) {
    const r = await client.from("academic_sessions").select("*").eq("id", settings.current_session_id).maybeSingle();
    session = r.data;
  }
  if (!session) {
    const r = await client.from("academic_sessions").select("*").eq("active", true).eq("is_test", false).order("created_at", { ascending: false }).limit(1).maybeSingle();
    session = r.data;
  }
  if (!session) throw new CommandCenterError("No active academic session is configured.");
  if (settings?.current_term_id) {
    const r = await client.from("terms").select("*").eq("id", settings.current_term_id).maybeSingle();
    term = r.data;
  }
  if (!term) {
    const r = await client.from("terms").select("*").eq("session_id", session.id).eq("active", true).order("display_order").limit(1).maybeSingle();
    term = r.data;
  }
  return { settings, session, term };
}

async function resolveCategory(client: AnyClient, name: string) {
  const requested = String(name || "").trim();
  if (!requested) throw new CommandCenterError("A financial category is required.");
  const candidates = requested.toUpperCase() === "U.P.E" ? ["U.P.E", "JUPEB"] : [requested];
  for (const value of candidates) {
    const { data } = await client.from("financial_categories").select("*").ilike("name", value).eq("active", true).limit(1).maybeSingle();
    if (data) return data;
  }
  throw new CommandCenterError(`Financial category '${requested}' was not found.`);
}

async function resolveClass(client: AnyClient, name: string) {
  const { data } = await client.from("classes").select("*").ilike("name", String(name || "").trim()).eq("active", true).limit(1).maybeSingle();
  if (!data) throw new CommandCenterError(`Class '${name}' was not found.`);
  return data;
}

async function resolveStudent(client: AnyClient, admissionNo: string) {
  const { data } = await client.from("students").select("*").eq("admission_no", String(admissionNo || "").trim()).limit(1).maybeSingle();
  if (!data) throw new CommandCenterError(`Student with admission number '${admissionNo}' was not found.`);
  return data;
}

async function categorySummary(client: AnyClient, category: Row, session: Row, term: Row | null) {
  const b = basis(category);
  const mixed = scope(category) === "mixed";
  let q = client.from("effective_payment_ledger").select("amount_paid,student_id,payment_date,class_id").eq("category_id", category.id).eq("session_id", session.id);
  if (b === "term" && term?.id) q = q.eq("term_id", term.id);
  const internalPayments = (await q).data || [];
  const externalPayments = mixed ? ((await client.from("effective_external_candidate_payment_ledger").select("amount_paid,external_candidate_id,payment_date").eq("category_id", category.id).eq("session_id", session.id)).data || []) : [];
  let eq = client.from("effective_school_expense_ledger").select("amount,expense_type,description,expense_date").eq("category_id", category.id).eq("session_id", session.id);
  if (b === "term" && term?.id) eq = eq.eq("term_id", term.id);
  const expenses = (await eq).data || [];

  const candidateRows = mixed ? ((await client.from("category_candidates").select("student_id,expected_amount_override").eq("category_id", category.id).eq("session_id", session.id)).data || []) : [];
  const externalCandidates = mixed ? ((await client.from("external_candidates").select("id,full_name,expected_amount,class_level").eq("category_id", category.id).eq("session_id", session.id).eq("active", true)).data || []) : [];

  const collected = [...internalPayments, ...externalPayments].reduce((a: number, r: Row) => a + Number(r.amount_paid || 0), 0);
  const spent = expenses.reduce((a: number, r: Row) => a + Number(r.amount || 0), 0);
  return {
    category: displayName(category),
    basis: b,
    candidate_scope: mixed ? "internal_and_external" : "internal_only",
    session: session.name,
    term: b === "term" ? term?.name || null : null,
    collected,
    expenses: spent,
    net_balance: collected - spent,
    internal_candidate_count: mixed ? candidateRows.length : null,
    external_candidate_count: mixed ? externalCandidates.length : null,
  };
}

export async function executeCommandTool(client: AnyClient, profile: Row, name: string, args: Record<string, any>) {
  const period = await currentPeriod(client);

  if (name === "get_financial_summary") {
    const { data: categories, error } = await client.from("financial_categories").select("*").eq("active", true).order("name");
    if (error) throw new CommandCenterError(error.message);
    const breakdown = [];
    for (const category of categories || []) breakdown.push(await categorySummary(client, category, period.session, period.term));
    const totalCollected = breakdown.reduce((a, r) => a + r.collected, 0);
    const totalExpenses = breakdown.reduce((a, r) => a + r.expenses, 0);
    return {
      principal: profile.full_name,
      session: period.session.name,
      term: period.term?.name || null,
      total_collected: totalCollected,
      total_expenses: totalExpenses,
      net_balance: totalCollected - totalExpenses,
      categories: breakdown,
    };
  }

  if (name === "get_category_report") {
    const category = await resolveCategory(client, args.category);
    const summary = await categorySummary(client, category, period.session, period.term);
    let internal: Row[] = [];
    if (scope(category) === "mixed") {
      const { data: registrations } = await client.from("category_candidates").select("student_id,expected_amount_override").eq("category_id", category.id).eq("session_id", period.session.id);
      const ids = (registrations || []).map((r: Row) => r.student_id);
      if (ids.length) {
        const { data } = await client.from("students").select("id,admission_no,full_name,class_id").in("id", ids);
        internal = data || [];
      }
    } else {
      const { data: mappings } = await client.from("financial_category_classes").select("class_id").eq("category_id", category.id);
      const classIds = (mappings || []).map((r: Row) => r.class_id);
      if (classIds.length) {
        const { data } = await client.from("students").select("id,admission_no,full_name,class_id").eq("academic_session_id", period.session.id).eq("status", "active").in("class_id", classIds);
        internal = data || [];
      }
    }
    const external = scope(category) === "mixed" ? ((await client.from("external_candidates").select("id,full_name,class_level,expected_amount,phone,source_school").eq("category_id", category.id).eq("session_id", period.session.id).eq("active", true)).data || []) : [];
    return { ...summary, internal_students_or_candidates: internal, external_candidates: external };
  }

  if (name === "list_students") {
    let q = client.from("students").select("id,admission_no,full_name,class_id,arm,status,guardian_name,guardian_phone,guardian_email").eq("academic_session_id", period.session.id).eq("status", "active").order("full_name");
    if (args.class_name) {
      const classRow = await resolveClass(client, args.class_name);
      q = q.eq("class_id", classRow.id);
    }
    if (args.search) q = q.or(`full_name.ilike.%${String(args.search).replaceAll(",", " ")}%,admission_no.ilike.%${String(args.search).replaceAll(",", " ")}%,guardian_phone.ilike.%${String(args.search).replaceAll(",", " ")}%`);
    const { data, error } = await q.limit(500);
    if (error) throw new CommandCenterError(error.message);
    return { session: period.session.name, count: data?.length || 0, students: data || [] };
  }

  if (name === "record_internal_payment") {
    const category = await resolveCategory(client, args.category);
    const student = await resolveStudent(client, args.admission_no);
    if (student.academic_session_id !== period.session.id) throw new CommandCenterError("That student is not in the current academic session.");
    if (scope(category) === "mixed") {
      const { data: registration } = await client.from("category_candidates").select("id").eq("category_id", category.id).eq("student_id", student.id).eq("session_id", period.session.id).maybeSingle();
      if (!registration) throw new CommandCenterError(`${displayName(category)} requires the internal student to be registered as a candidate first.`);
    }
    const termId = basis(category) === "term" ? period.term?.id || null : null;
    const payload = {
      student_id: student.id,
      class_id: student.class_id,
      category_id: category.id,
      amount_paid: Number(args.amount),
      payment_date: args.payment_date || today(),
      session_id: period.session.id,
      term_id: termId,
      note: args.note || null,
    };
    const { data, error } = await client.from("student_payments").insert(payload).select("id,reference_no,amount_paid,payment_date").single();
    if (error) throw new CommandCenterError(error.message);
    return { ok: true, message: "Internal payment recorded and protected.", student: student.full_name, category: displayName(category), payment: data };
  }

  if (name === "add_external_candidate") {
    const category = await resolveCategory(client, args.category);
    if (scope(category) !== "mixed" || !["WAEC", "NECO"].includes(String(category.name).toUpperCase())) throw new CommandCenterError("External candidates are only allowed for WAEC and NECO.");
    const payload = {
      full_name: String(args.full_name).trim(),
      phone: args.phone || null,
      source_school: args.source_school || null,
      category_id: category.id,
      session_id: period.session.id,
      class_level: args.class_level || "Other",
      expected_amount: args.expected_amount ?? null,
    };
    const { data, error } = await client.from("external_candidates").insert(payload).select("id,full_name,class_level,expected_amount").single();
    if (error) throw new CommandCenterError(error.message);
    return { ok: true, message: "External candidate added without entering the school register.", category: displayName(category), candidate: data };
  }

  if (name === "record_external_payment") {
    const category = await resolveCategory(client, args.category);
    if (scope(category) !== "mixed") throw new CommandCenterError("External payments are only available for WAEC and NECO.");
    const { data: matches, error: findError } = await client.from("external_candidates").select("id,full_name,class_level").eq("category_id", category.id).eq("session_id", period.session.id).eq("active", true).ilike("full_name", String(args.candidate_name).trim()).limit(5);
    if (findError) throw new CommandCenterError(findError.message);
    if (!matches?.length) throw new CommandCenterError(`External candidate '${args.candidate_name}' was not found under ${displayName(category)}.`);
    if (matches.length > 1) throw new CommandCenterError("More than one external candidate has that name. Use the portal to disambiguate before recording money.");
    const { data, error } = await client.from("external_candidate_payments").insert({ external_candidate_id: matches[0].id, category_id: category.id, amount_paid: Number(args.amount), payment_date: args.payment_date || today(), session_id: period.session.id, note: args.note || null }).select("id,reference_no,amount_paid,payment_date").single();
    if (error) throw new CommandCenterError(error.message);
    return { ok: true, message: "External candidate payment recorded and protected.", candidate: matches[0].full_name, category: displayName(category), payment: data };
  }

  if (name === "record_expense") {
    const category = await resolveCategory(client, args.category);
    const termId = basis(category) === "term" ? period.term?.id || null : null;
    const { data, error } = await client.from("school_expenses").insert({ category_id: category.id, expense_type: String(args.expense_type).trim(), description: args.description || null, amount: Number(args.amount), expense_date: args.expense_date || today(), session_id: period.session.id, term_id: termId, note: args.note || null }).select("id,reference_no,amount,expense_type,expense_date").single();
    if (error) throw new CommandCenterError(error.message);
    return { ok: true, message: "Expense recorded against the selected fund.", category: displayName(category), expense: data };
  }

  if (name === "add_student") {
    const classRow = await resolveClass(client, args.class_name);
    const payload = {
      admission_no: String(args.admission_no).trim(),
      full_name: String(args.full_name).trim(),
      class_id: classRow.id,
      arm: args.arm || null,
      status: "active",
      academic_session_id: period.session.id,
      guardian_name: args.guardian_name || null,
      guardian_phone: args.guardian_phone || null,
      guardian_email: args.guardian_email || null,
    };
    const { data, error } = await client.from("students").insert(payload).select("id,admission_no,full_name,class_id").single();
    if (error) throw new CommandCenterError(error.message);
    return { ok: true, message: "Student added to the internal master register.", student: data, class: classRow.name };
  }

  if (name === "set_current_period") {
    const { data: sessionRow } = await client.from("academic_sessions").select("*").ilike("name", String(args.session).trim()).eq("is_test", false).limit(1).maybeSingle();
    if (!sessionRow) throw new CommandCenterError(`Session '${args.session}' was not found.`);
    let termId: string | null = null;
    if (args.term) {
      const { data: termRow } = await client.from("terms").select("*").eq("session_id", sessionRow.id).eq("name", args.term).maybeSingle();
      if (!termRow) throw new CommandCenterError(`Term '${args.term}' was not found in ${sessionRow.name}.`);
      termId = termRow.id;
    }
    const { error } = await client.from("portal_settings").upsert({ id: 1, current_session_id: sessionRow.id, current_term_id: termId, updated_by: profile.id });
    if (error) throw new CommandCenterError(error.message);
    return { ok: true, message: "Current academic period updated. Historical records were not changed.", session: sessionRow.name, term: args.term || null };
  }

  if (name === "set_expected_charge") {
    const category = await resolveCategory(client, args.category);
    const classRow = await resolveClass(client, args.class_name);
    const termId = basis(category) === "term" ? period.term?.id || null : null;
    let q = client.from("expected_charges").select("id").eq("category_id", category.id).eq("class_id", classRow.id).eq("session_id", period.session.id);
    q = termId ? q.eq("term_id", termId) : q.is("term_id", null);
    const { data: existing } = await q.maybeSingle();
    const write = existing
      ? client.from("expected_charges").update({ expected_amount: Number(args.amount), active: true }).eq("id", existing.id)
      : client.from("expected_charges").insert({ category_id: category.id, class_id: classRow.id, session_id: period.session.id, term_id: termId, expected_amount: Number(args.amount), active: true });
    const { error } = await write;
    if (error) throw new CommandCenterError(error.message);
    return { ok: true, message: "Expected amount saved.", category: displayName(category), class: classRow.name, amount: Number(args.amount) };
  }

  if (name === "set_internal_exam_registration") {
    const category = await resolveCategory(client, args.category);
    if (scope(category) !== "mixed") throw new CommandCenterError("Internal exam registration management is only for WAEC and NECO.");
    const student = await resolveStudent(client, args.admission_no);
    const { data: existing } = await client.from("category_candidates").select("id").eq("category_id", category.id).eq("student_id", student.id).eq("session_id", period.session.id).maybeSingle();
    if (args.registered) {
      if (existing) {
        if (args.expected_amount_override !== undefined) {
          const { error } = await client.from("category_candidates").update({ expected_amount_override: Number(args.expected_amount_override) }).eq("id", existing.id);
          if (error) throw new CommandCenterError(error.message);
        }
      } else {
        const { error } = await client.from("category_candidates").insert({ category_id: category.id, student_id: student.id, session_id: period.session.id, expected_amount_override: args.expected_amount_override ?? null });
        if (error) throw new CommandCenterError(error.message);
      }
    } else if (existing) {
      const { error } = await client.from("category_candidates").delete().eq("id", existing.id);
      if (error) throw new CommandCenterError(error.message);
    }
    return { ok: true, message: args.registered ? "Internal exam candidate registered." : "Internal exam candidate removed from this registration list.", category: displayName(category), student: student.full_name, registered: Boolean(args.registered) };
  }

  throw new CommandCenterError(`Unknown command-center tool '${name}'.`, 404);
}
