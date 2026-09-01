Warning: truncated output (original token count: 22381)
Total output lines: 818

"use client";

import Image from "next/image";
import Link from "next/link";
import * as XLSX from "xlsx";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase-browser";
import { csvEscape, dateTime, initials, naira, numberValue, shortDate, todayISO } from "@/lib/format";
import type {
  AcademicSession,
  AuditLog,
  CorrectionRequest,
  ExpectedCharge,
  FinancialCategory,
  Handover,
  HandoverItem,
  Permission,
  PermissionKey,
  PersonalExpense,
  PersonalProduct,
  PersonalSale,
  Payment,
  PortalData,
  Profile,
  SchoolClass,
  Student,
  Term,
} from "@/lib/types";

type AnyClient = SupabaseClient<any>;
type Tab = "overview" | "payments" | "handover" | "students" | "categories" | "staff" | "personal" | "audit";
type Toast = { type: "success" | "error" | "info"; message: string } | null;

const permissionOptions: Array<{ key: PermissionKey; label: string; description: string }> = [
  { key: "record_student_payments", label: "Record student payments", description: "Create new locked payment records." },
  { key: "view_students", label: "View students", description: "View student names, classes and ledgers." },
  { key: "view_own_collections", label: "View own collections", description: "View payments personally recorded." },
  { key: "view_all_collections", label: "View all collections", description: "View collections recorded by all staff." },
  { key: "create_handover", label: "Create handover", description: "Submit money in personal custody." },
  { key: "confirm_handovers", label: "Confirm handovers", description: "Confirm or query staff handovers." },
  { key: "view_school_reports", label: "View school reports", description: "View principal-level summaries." },
  { key: "manage_financial_categories", label: "Manage financial categories", description: "Manage categories and expected charges." },
  { key: "manage_students", label: "Manage students", description: "Import and update student records." },
  { key: "manage_staff", label: "Manage staff", description: "Create staff and set permissions." },
  { key: "principal_dashboard", label: "Principal/Admin dashboard", description: "Open principal-level controls." },
  { key: "personal_business", label: "Personal Business access", description: "Use the private business section." },
];

const navItems: Array<{ id: Tab; label: string; icon: string; permission?: PermissionKey }> = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "payments", label: "Payments", icon: "₦", permission: "record_student_payments" },
  { id: "handover", label: "Money handover", icon: "↔", permission: "create_handover" },
  { id: "students", label: "Students", icon: "☷", permission: "view_students" },
  { id: "categories", label: "Categories", icon: "▦", permission: "manage_financial_categories" },
  { id: "staff", label: "Staff & access", icon: "♙", permission: "manage_staff" },
  { id: "personal", label: "Personal Business", icon: "◇", permission: "personal_business" },
  { id: "audit", label: "Audit trail", icon: "◌", permission: "view_school_reports" },
];

const moneyFilters = [
  { value: "today", label: "Today" },
  { value: "term", label: "This term" },
  { value: "all", label: "All dates" },
] as const;

function messageFrom(error: unknown) {
  if (!error) return "Something went wrong.";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) return String(error.message);
  return "Something went wrong. Please try again.";
}

async function fetchTable(client: AnyClient, table: string, select = "*"): Promise<any[]> {
  const { data, error } = await client.from(table).select(select);
  if (error) throw error;
  return data || [];
}

async function fetchOptionalTable(client: AnyClient, table: string, select = "*"): Promise<any[]> {
  const { data, error } = await client.from(table).select(select);
  if (error) {
    console.warn(`Optional table ${table} could not be read`, error.message);
    return [];
  }
  return data || [];
}

async function loadPortalData(client: AnyClient, user: User): Promise<PortalData> {
  const { data: profileRow, error: profileError } = await client
    .from("profiles")
    .select("id,full_name,email,role,active,staff_code")
    .eq("id", user.id)
    .single();
  if (profileError) throw profileError;
  if (!profileRow || !profileRow.active) throw new Error("This account is inactive. Ask the Principal to reactivate it.");

  const profile = profileRow as Profile;
  const [permissionRows, ownPermissionRows] = await Promise.all([
    fetchOptionalTable(client, "permissions", "key,label,description"),
    fetchOptionalTable(client, "profile_permissions", "permission_key"),
  ]);
  const permissionKeys = new Set<PermissionKey>((ownPermissionRows as Array<{ permission_key: PermissionKey }>).map((row) => row.permission_key));
  const can = (permission: PermissionKey) => profile.role === "principal" || permissionKeys.has(permission);

  const [classes, sessions, terms, categories, categoryClasses, students, charges, payments, corrections, handovers, handoverItems] = await Promise.all([
    fetchOptionalTable(client, "classes", "id,name,display_order,active"),
    fetchOptionalTable(client, "academic_sessions", "id,name,starts_on,ends_on,active"),
    fetchOptionalTable(client, "terms", "id,session_id,name,display_order,active"),
    fetchOptionalTable(client, "financial_categories", "id,name,applicable_to_term,active"),
    fetchOptionalTable(client, "financial_category_classes", "category_id,class_id"),
    can("view_students") || can("record_student_payments") || can("view_school_reports") ? fetchTable(client, "students", "id,admission_no,full_name,class_id,arm,status,academic_session_id") : Promise.resolve([]),
    can("view_school_reports") || can("manage_financial_categories") ? fetchOptionalTable(client, "expected_charges", "id,category_id,class_id,session_id,term_id,expected_amount,active") : Promise.resolve([]),
    can("record_student_payments") || can("view_own_collections") || can("view_all_collections") || can("view_school_reports") ? fetchOptionalTable(client, "effective_payment_ledger", "*") : Promise.resolve([]),
    can("record_student_payments") || can("view_school_reports") ? fetchOptionalTable(client, "payment_correction_requests", "*") : Promise.resolve([]),
    can("create_handover") || can("confirm_handovers") || can("view_all_collections") || can("view_school_reports") ? fetchOptionalTable(client, "handovers", "*") : Promise.resolve([]),
    can("create_handover") || can("confirm_handovers") || can("view_all_collections") || can("view_school_reports") ? fetchOptionalTable(client, "handover_items", "*") : Promise.resolve([]),
  ]);

  const visibleProfiles = can("view_all_collections") || can("view_school_reports") || can("manage_staff")
    ? await fetchOptionalTable(client, "profiles", "id,full_name,email,role,active,staff_code")
    : [];
  const classMap = new Map((classes as SchoolClass[]).map((item) => [item.id, item]));
  const sessionMap = new Map((sessions as AcademicSession[]).map((item) => [item.id, item]));
  const termMap = new Map((terms as Term[]).map((item) => [item.id, item]));
  const categoryMap = new Map((categories as FinancialCategory[]).map((item) => [item.id, item]));
  const studentMap = new Map((students as Student[]).map((item) => [item.id, item]));
  const profileMap = new Map((visibleProfiles as Profile[]).map((item) => [item.id, item]));
  const decoratedStudents = (students as Student[]).map((student) => ({ ...student, class: classMap.get(student.class_id) }));
  const decoratedPayments = (payments as Payment[]).map((payment) => ({
    ...payment,
    amount_paid: numberValue(payment.amount_paid),
    student: studentMap.get(payment.student_id) ? { full_name: studentMap.get(payment.student_id)!.full_name, admission_no: studentMap.get(payment.student_id)!.admission_no } : undefined,
    class: classMap.get(payment.class_id) ? { name: classMap.get(payment.class_id)!.name } : undefined,
    category: categoryMap.get(payment.category_id) ? { name: categoryMap.get(payment.category_id)!.name } : undefined,
    collector: profileMap.get(payment.collector_id) ? { full_name: profileMap.get(payment.collector_id)!.full_name } : payment.collector_id === profile.id ? { full_name: profile.full_name } : undefined,
    session: sessionMap.get(payment.session_id) ? { name: sessionMap.get(payment.session_id)!.name } : undefined,
    term: payment.term_id && termMap.get(payment.term_id) ? { name: termMap.get(payment.term_id)!.name } : null,
  }));
  const decoratedCorrections = (corrections as CorrectionRequest[]).map((request) => ({
    ...request,
    requested_amount: request.requested_amount == null ? null : numberValue(request.requested_amount),
    original_payment: decoratedPayments.find((payment) => payment.id === request.original_payment_id),
  }));
  const decoratedItems = (handoverItems as HandoverItem[]).map((item) => ({
    ...item,
    amount: numberValue(item.amount),
    payment: decoratedPayments.find((payment) => payment.id === item.payment_id),
  }));

  const decoratedHandovers = (handovers as Handover[]).map((handover) => ({
    ...handover,
    total_amount: numberValue(handover.total_amount),
    staff: profileMap.get(handover.staff_id) ? { full_name: profileMap.get(handover.staff_id)!.full_name } : undefined,
    reviewer: handover.reviewed_by && profileMap.get(handover.reviewed_by) ? { full_name: profileMap.get(handover.reviewed_by)!.full_name } : undefined,
  }));

  let staffProfiles: Profile[] = (visibleProfiles as Profile[]).filter((item) => item.role === "staff");
  let staffPermissionMap: Record<string, PermissionKey[]> = {};
  if (can("manage_staff")) {
    const allAssignments = await fetchOptionalTable(client, "profile_permissions", "profile_id,permission_key");
    staffPermissionMap = (allAssignments as Array<{ profile_id: string; permission_key: PermissionKey }>).reduce<Record<string, PermissionKey[]>>((result, row) => {
      result[row.profile_id] = [...(result[row.profile_id] || []), row.permission_key];
      return result;
    }, {});
  }

  const hasPersonal = can("personal_business");
  const [personalProducts, personalSales, personalExpenses] = hasPersonal
    ? await Promise.all([
        fetchOptionalTable(client, "personal_products", "*"),
        fetchOptionalTable(client, "personal_sales", "*"),
        fetchOptionalTable(client, "personal_expenses", "*"),
      ])
    : [[], [], []];
  const productMap = new Map((personalProducts as PersonalProduct[]).map((product) => [product.id, product]));
  const decoratedSales = (personalSales as PersonalSale[]).map((sale) => ({
    ...sale,
    quantity: Number(sale.quantity),
    unit_price: numberValue(sale.unit_price),
    unit_cost: numberValue(sale.unit_cost),
    product: productMap.get(sale.product_id) ? { name: productMap.get(sale.product_id)!.name, cost_price: productMap.get(sale.product_id)!.cost_price } : undefined,
  }));
  const auditLogs = can("view_school_reports") ? await fetchOptionalTable(client, "audit_logs", "*") : [];

  return {
    profile,
    permissions: permissionRows as Permission[],
    classes: classes as SchoolClass[],
    sessions: sessions as AcademicSession[],
    terms: terms as Term[],
    categories: categories as FinancialCategory[],
    categoryClasses: categoryClasses as Array<{ category_id: string; class_id: string }>,
    students: decoratedStudents,
    charges: charges as ExpectedCharge[],
    payments: decoratedPayments,
    corrections: decoratedCorrections,
    handovers: decoratedHandovers,
    handoverItems: decoratedItems,
    personalProducts: personalProducts as PersonalProduct[],
    personalSales: decoratedSales,
    personalExpenses: personalExpenses as PersonalExpense[],
    auditLogs: auditLogs as AuditLog[],
    staffProfiles,
    staffPermissionMap,
  };
}

function SchoolBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`school-brand ${compact ? "compact" : ""}`}>
      <Image src="/ilawo-mark.svg" alt="Ilawo Community Grammar School mark" width={compact ? 42 : 48} height={compact ? 42 : 48} priority />
      <div>
        <p className="brand-name">ILAWO COMMUNITY GRAMMAR SCHOOL</p>
        <p className="brand-location">ILAWO · KNOWLEDGE IS LIGHT</p>
      </div>
    </div>
  );
}

function LoginScreen({ client, configured }: { client: AnyClient | null; configured: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    setBusy(true);
    setError("");
    const { error: signInError } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (signInError) setError(signInError.message);
    setBusy(false);
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <SchoolBrand />
        <div className="auth-heading">
          <span className="section-kicker">OFFICE OF THE PRINCIPAL</span>
          <h1>School money, clearly recorded.</h1>
          <p>Record payments, track custody and confirm every handover from one simple place.</p>
        </div>
        {!configured ? (
          <div className="setup-alert">
            <strong>Portal setup is incomplete</strong>
            <p>Add the public Supabase URL and key to the environment, then apply the database migration.</p>
          </div>
        ) : (
          <form className="stack-form" onSubmit={submit}>
            <label>Login email<input required type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></label>
            <label>Password<input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Your password" /></label>
            {error && <p className="form-error">{error}</p>}
            <button className="button primary full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        )}
        <div className="auth-footer">
          <span>Private school finance system</span>
          <Link href="/setup">First-time setup</Link>
        </div>
      </section>
    </main>
  );
}

function MetricCard({ label, value, helper, tone = "teal" }: { label: string; value: string; helper?: string; tone?: "teal" | "gold" | "ink" | "rose" }) {
  return (
    <div className={`metric-card ${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      {helper && <span>{helper}</span>}
    </div>
  );
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "info" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><div><span className="section-kicker">ILAWO FINANCE</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
        {children}
      </section>
    </div>
  );
}

function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">◇</div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="page-header"><div><span className="section-kicker">OFFICE OF THE PRINCIPAL</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

function SelectField({ label, value, onChange, children, required = false }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode; required?: boolean }) {
  return <label className="field-label">{label}<select required={required} value={value} onChange={(e) => onChange(e.target.value)}>{children}</select></label>;
}

function TextField({ label, value, onChange, type = "text", placeholder, required = false, min, step }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; required?: boolean; min?: string; step?: string }) {
  return <label className="field-label">{label}<input required={required} type={type} value={value} min={min} step={step} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} /></label>;
}

function StatusCounts({ fullyPaid, partPaid, unpaid, onSelect }: { fullyPaid: number; partPaid: number; unpaid: number; onSelect: (status: "fully" | "part" | "unpaid") => void }) {
  return <div className="status-counts"><button onClick={() => onSelect("fully")}><strong>{fullyPaid}</strong><span>Fully paid</span></button><button onClick={() => onSelect("part")}><strong>{partPaid}</strong><span>Part-paid</span></button><button onClick={() => onSelect("unpaid")}><strong>{unpaid}</strong><span>Unpaid</span></button></div>;
}

function OverviewView({
  data,
  can,
  onGo,
  onRefresh,
}: {
  data: PortalData;
  can: (permission: PermissionKey) => boolean;
  onGo: (tab: Tab) => void;
  onRefresh: () => Promise<void>;
}) {
  const currentSession = data.sessions.find((session) => session.active) || data.sessions[0];
  const currentTerm = data.terms.find((term) => term.session_id === currentSession?.id && term.active) || data.terms.find((term) => term.session_id === currentSession?.id);
  const [range, setRange] = useState<(typeof moneyFilters)[number]["value"]>("today");
  const [selectedSession, setSelectedSession] = useState(currentSession?.id || "");
  const [selectedTerm, setSelectedTerm] = useState(currentTerm?.id || "");
  const [selectedClass, setSelectedClass] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [classSummary, setClassSummary] = useState<{ classId: string; categoryId: string; status: "fully" | "part" | "unpaid" } | null>(null);

  const activeSession = data.sessions.find((session) => session.id === selectedSession);
  const visibleTerms = data.terms.filter((term) => term.session_id === selectedSession);
  const paymentsForFilters = useMemo(() => data.payments.filter((payment) => {
    if (range === "today" && payment.payment_date !== todayISO()) return false;
    if (range === "term" && selectedTerm && payment.term_id !== selectedTerm) return false;
    if (selectedSession && payment.session_id !== selectedSession) return false;
    if (selectedClass && payment.class_id !== selectedClass) return false;
    if (selectedCategory && payment.category_id !== selectedCategory) return false;
    return true;
  }), [data.payments, range, selectedTerm, selectedSession, selectedClass, selectedCategory]);
  const confirmedPaymentIds = useMemo(() => new Set(data.handoverItems.filter((item) => data.handovers.find((handover) => handover.id === item.handover_id)?.status === "confirmed").map((item) => item.payment_id)), [data.handoverItems, data.handovers]);
  const collectedToday = data.payments.filter((payment) => payment.payment_date === todayISO()).reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0);
  const collectedTerm = data.payments.filter((payment) => selectedTerm ? payment.term_id === selectedTerm : payment.session_id === selectedSession).reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0);
  const moneyWithPrincipal = data.payments.filter((payment) => confirmedPaymentIds.has(payment.id)).reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0);
  const moneyWithStaff = data.payments.filter((payment) => !confirmedPaymentIds.has(payment.id)).reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0);
  const pendingHandovers = data.handovers.filter((handover) => handover.status === "pending");
  const studentBalances = useMemo(() => {
    const result = new Map<string, number>();
    for (const payment of data.payments) result.set(payment.student_id, (result.get(payment.student_id) || 0) + numberValue(payment.amount_paid));
    return result;
  }, [data.payments]);

  function categorySummary(category: FinancialCategory) {
    const students = data.students.filter((student) => (!selectedClass || student.class_id === selectedClass) && student.status === "active" && data.categoryClasses.some((item) => item.category_id === category.id && item.class_id === student.class_id));
    const payments = paymentsForFilters.filter((payment) => payment.category_id === category.id);
    const expected = students.reduce((sum, student) => {
      const charge = data.charges.find((item) => item.category_id === category.id && item.class_id === student.class_id && item.session_id === selectedSession && (item.term_id === selectedTerm || (!item.term_id && !category.applicable_to_term)) && item.active);
      return sum + numberValue(charge?.expected_amount);
    }, 0);
    const paidByStudent = new Map<string, number>();
    for (const payment of payments) paidByStudent.set(payment.student_id, (paidByStudent.get(payment.student_id) || 0) + numberValue(payment.amount_paid));
    let fullyPaid = 0; let partPaid = 0; let unpaid = 0;
    for (const student of students) {
      const charge = data.charges.find((item) => item.category_id === category.id && item.class_id === student.class_id && item.session_id === selectedSession && (item.term_id === selectedTerm || (!item.term_id && !category.applicable_to_term)) && item.active);
      const expectedAmount = numberValue(charge?.expected_amount);
      const paid = paidByStudent.get(student.id) || 0;
      if (expectedAmount <= 0) continue;
      if (paid >= expectedAmount) fullyPaid += 1;
      else if (paid > 0) partPaid += 1;
      else unpaid += 1;
    }
    return { collected: payments.reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0), expected, outstanding: Math.max(expected - payments.reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0), 0), fullyPaid, partPaid, unpaid, studentCount: students.length };
  }

  const selectedCategoryObject = selectedCategory ? data.categories.find((category) => category.id === selectedCategory) : undefined;
  const selectedClassObject = selectedClass ? data.classes.find((item) => item.id === selectedClass) : undefined;
  const statusStudents = classSummary ? data.students.filter((student) => {
    if (student.class_id !== classSummary.classId || student.status !== "active") return false;
    const paid = data.payments.filter((payment) => payment.student_id === student.id && payment.category_id === classSummary.categoryId && payment.session_id === selectedSession && (!selectedTerm || payment.term_id === selectedTerm)).reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0);
    const charge = data.charges.find((item) => item.category_id === classSummary.categoryId && item.class_id === student.class_id && item.session_id === selectedSession && (item.term_id === selectedTerm || !item.term_id) && item.active);
    const expected = numberValue(charge?.expected_amount);
    const status = expected > 0 && paid >= expected ? "fully" : paid > 0 ? "part" : "unpaid";
    return status === classSummary.status;
  }) : [];

  return (
    <div className="content-wrap">
      <PageHeader title={`Good day, ${data.profile.full_name.split(" ")[0]}`} description={data.profile.role === "principal" ? "Here is the school's money position at a glance." : "Here is your collection desk for today."} action={<button className="button ghost" onClick={() => void onRefresh()}>↻ Refresh</button>} />
      <div className="quick-actions">
        {can("record_student_payments") && <button className="button primary" onClick={() => onGo("payments")}>＋ Record payment</button>}
        {can("create_handover") && <button className="button secondary" onClick={() => onGo("handover")}>↔ Hand over money</button>}
        {can("view_students") && <button className="button ghost" onClick={() => onGo("students")}>☷ Students</button>}
      </div>
      <div className="metric-grid">
        <MetricCard label="Total collected today" value={naira(collectedToday)} helper="All recorded payments" tone="teal" />
        <MetricCard label="Total collected this term" value={naira(collectedTerm)} helper={activeSession?.name || "Active session"} tone="gold" />
        <MetricCard label="Money with Principal" value={naira(moneyWithPrincipal)} helper="Confirmed handovers" tone="ink" />
        <MetricCard label="Money still with staff" value={naira(moneyWithStaff)} helper="Until Principal confirms" tone="rose" />
        <MetricCard label="Pending handovers" value={String(pendingHandovers.length)} helper="Need Principal action" tone="gold" />
        <MetricCard label="Students owing" value={String(data.students.filter((student) => student.status === "active" && (studentBalances.get(student.id) || 0) === 0).length)} helper="Set expected charges for exact balances" tone="teal" />
      </div>

      <section className="panel filters-panel">
        <div className="panel-heading"><div><span className="section-kicker">REPORT FILTERS</span><h2>See the right period</h2></div><span className="muted">Totals below follow these filters.</span></div>
        <div className="filter-row">
          <div className="segmented">{moneyFilters.map((filter) => <button key={filter.value} className={range === filter.value ? "active" : ""} onClick={() => setRange(filter.value)}>{filter.label}</button>)}</div>
          <SelectField label="Session" value={selectedSession} onChange={(value) => { setSelectedSession(value); setSelectedTerm(data.terms.find((term) => term.session_id === value)?.id || ""); }}><option value="">All sessions</option>{data.sessions.map((session) => <option key={session.id} value={session.id}>{session.name}{session.active ? " · Active" : ""}</option>)}</SelectField>
          <SelectField label="Term" value={selectedTerm} onChange={setSelectedTerm}><option value="">All terms</option>{visibleTerms.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}</SelectField>
          <SelectField label="Class" value={selectedClass} onChange={setSelectedClass}><option value="">All classes</option>{data.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField>
          <SelectField label="Category" value={selectedCategory} onChange={setSelectedCategory}><option value="">All categories</option>{data.categories.filter((category) => category.active).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</SelectField>
        </div>
      </section>

      {data.profile.role === "principal" || can("view_school_reports") ? (
        <section className="panel">
          <div className="panel-heading"><div><span className="section-kicker">SCHOOL FINANCES</span><h2>Category summary</h2></div><span className="muted">{paymentsForFilters.length} payment record{paymentsForFilters.length === 1 ? "" : "s"} in view</span></div>
          <div className="category-grid">
            {data.categories.filter((category) => category.active).map((category) => {
              const summary = categorySummary(category);
              return <article className="category-card" key={category.id}><div className="category-card-top"><h3>{category.name}</h3><Badge tone={summary.expected ? "info" : "warning"}>{summary.expected ? "Amount set" : "Set expected amount"}</Badge></div><strong>{naira(summary.collected)}</strong><p>Collected · Expected {summary.expected ? naira(summary.expected) : "not configured"}</p><StatusCounts fullyPaid={summary.fullyPaid} partPaid={summary.partPaid} unpaid={summary.unpaid} onSelect={(status) => { if (selectedClass) setClassSummary({ classId: selectedClass, categoryId: category.id, status }); }} /><div className="category-footer"><span>Outstanding</span><b>{summary.expected ? naira(summary.outstanding) : "—"}</b></div></article>;
            })}
          </div>
          {!selectedClass && <p className="helper-line">Choose a class to make the paid, part-paid and unpaid numbers clickable.</p>}
          {classSummary && <div className="student-status-panel"><div className="panel-heading"><div><span className="section-kicker">STUDENT LIST</span><h3>{selectedClassObject?.name} · {selectedCategoryObject?.name} · {classSummary.status === "fully" ? "Fully paid" : classSummary.status === "part" ? "Part-paid" : "Unpaid"}</h3></div><button className="text-button" onClick={() => setClassSummary(null)}>Close list</button></div>{statusStudents.length ? <div className="simple-list">{statusStudents.map((student) => <div className="simple-list-row" key={student.id}><div><strong>{student.full_name}</strong><span>{student.admission_no}{student.arm ? ` · Arm ${student.arm}` : ""}</span></div><span>{naira(data.payments.filter((payment) => payment.student_id === student.id && payment.category_id === classSummary.categoryId).reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0))}</span></div>)}</div> : <p className="muted">No students match this status in the selected period.</p>}</div>}
        </section>
      ) : (
        <section className="panel staff-note"><span className="section-kicker">YOUR COLLECTION DESK</span><h2>Money recorded by you remains yours to hand over.</h2><p>It will not enter Money With Principal until the Principal confirms the exact handover.</p><button className="button secondary" onClick={() => onGo("handover")}>View money in my custody</button></section>
      )}

      <section className="two-column">
        <div className="panel"><div className="panel-heading"><div><span className="section-kicker">HANDOVERS</span><h2>Needs attention</h2></div><button className="text-button" onClick={() => onGo("handover")}>Open handovers →</button></div>{pendingHandovers.length ? pendingHandovers.slice(0, 4).map((handover) => <div className="handover-row" key={handover.id}><div><strong>{handover.staff_id === data.profile.id ? "My handover" : "Staff handover"}</strong><span>{shortDate(handover.submitted_at)} · {handover.id.slice(0, 8).toUpperCase()}</span></div><div><b>{naira(handover.total_amount)}</b><Badge tone="warning">Pending</Badge></div></div>) : <p className="muted">No pending handovers.</p>}</div>
        <div className="panel"><div className="panel-heading"><div><span className="section-kicker">RECENT PAYMENTS</span><h2>Latest records</h2></div><button className="text-button" onClick={() => onGo("payments")}>View all →</button></div>{data.payments.slice(0, 5).map((payment) => <div className="payment-row" key={payment.id}><div className="avatar">{initials(payment.student?.full_name)}</div><div><strong>{payment.student?.full_name || "Student record"}</strong><span>{payment.category?.name || "Category"} · {payment.reference_no}</span></div><b>{naira(payment.amount_paid)}</b></div>)}{!data.payments.length && <p className="muted">No payments have been recorded yet.</p>}</div>
      </section>
    </div>
  );
}

function PaymentsView({ data, can, client, onRefresh, onToast }: { data: PortalData; can: (permission: PermissionKey) => boolean; client: AnyClient; onRefresh: () => Promise<void>; onToast: (toast: NonNullable<Toast>) => void }) {
  const [mode, setMode] = useState<"single" | "batch" | "history">("single");
  const [classId, setClassId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [sessionId, setSessionId] = useState(data.sessions.find((session) => session.active)?.id || data.sessions[0]?.id || "");
  const [termId, setTermId] = useState("");
  const [paymentDate, setPaymentDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [batchAmounts, setBatchAmounts] = useState<Record<string, string>>({});
  const [batchReview, setBatchReview] = useState(false);
  const [selectedCorrection, setSelectedCorrection] = useState<Payment | null>(null);
  const [correctionAction, setCorrectionAction] = useState<"reverse" | "correct">("reverse");
  const [correctionAmount, setCorrectionAmount] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [busy, setBusy] = useState(false);

  const sessionTerms = data.terms.filter((term) => term.session_id === sessionId);
  const studentsInClass = data.students.filter((student) => !classId || student.class_id === classId).filter((student) => `${student.full_name} ${student.admission_no}`.toLowerCase().includes(search.toLowerCase()));
  const categoriesForClass = data.categories.filter((category) => category.active && (!classId || data.categoryClasses.some((item) => item.category_id === category.id && item.class_id === classId)));

  async function submitSingle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!studentId || !classId || !categoryId || !sessionId || numberValue(amount) <= 0) return;
    setBusy(true);
    const { error } = await client.from("student_payments").insert({ student_id: studentId, class_id: classId, category_id: categoryId, amount_paid: numberValue(amount), payment_date: paymentDate, session_id: sessionId, term_id: termId || null, note: note.trim() || null });
    setBusy(false);
    if (error) { onToast({ type: "error", message: error.message }); return; }
    onToast({ type: "success", message: "Payment recorded and locked." });
    setStudentId(""); setAmount(""); setNote(""); setSearch("");
    await onRefresh();
  }

  async function submitBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entries = Object.entries(batchAmounts).filter(([, value]) => numberValue(value) > 0).map(([id, value]) => { const student = data.students.find((item) => item.id === id)!; return { student_id: student.id, class_id: student.class_id, category_id: categoryId, amount_paid: numberValue(value), payment_date: paymentDate, session_id: sessionId, term_id: termId || null, note: note.trim() || null }; });
    if (!classId || !categoryId || !sessionId || !entries.length) return;
    if (!batchReview) { setBatchReview(true); return; }
    setBusy(true);
    const { error } = await client.from("student_payments").insert(entries);
    setBusy(false);
    if (error) { onToast({ type: "error", message: error.message }); return; }
    onToast({ type: "success", message: `${entries.length} payment${entries.length === 1 ? "" : "s"} recorded and locked.` });
    setBatchAmounts({}); setNote(""); setBatchReview(false);
    await onRefresh();
  }

  async function requestCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCorrection || correctionReason.trim().length < 5) return;
    setBusy(true);
    const { error } = await client.from("payment_correction_requests").insert({ original_payment_id: selectedCorrection.id, action: correctionAction, requested_amount: correctionAction === "correct" ? numberValue(correctionAmount) : null, reason: correctionReason.trim() });
    setBusy(false);
    if (error) { onToast({ type: "error", message: error.message }); return; }
    setSelectedCorrection(null); setCorrectionReason(""); setCorrectionAmount("");
    onToast({ type: "success", message: "Correction request sent to the Principal." });
    await onRefresh();
  }

  async function reviewCorrection(request: CorrectionRequest, approve: boolean) {
    setBusy(true);
    const { error } = await client.rpc("review_payment_correction", { p_request_id: request.id, p_approve: approve, p_decision_note: approve ? "Approved after review" : "Rejected after review" });
    setBusy(false);
    if (error) { onToast({ type: "error", message: error.message }); return; }
    onToast({ type: "success", message: approve ? "Correction approved and linked." : "Correction rejected." });
    await onRefresh();
  }

  return (
    <div className="content-wrap">
      <PageHeader title="Payments" description="Create locked records for every naira collected." action={<Badge tone="info">Insert-only records</Badge>} />
      {can("record_student_payments") && <div className="mode-tabs"><button className={mode === "single" ? "active" : ""} onClick={() => setMode("single")}>Record payment</button><button className={mode === "batch" ? "active" : ""} onClick={() => setMode("batch")}>Class batch entry</button><button className={mode === "history" ? "active" : ""} onClick={() => setMode("history")}>Payment history</button></div>}
      {mode === "single" && can("record_student_payments") && <section className="panel form-panel"><div className="panel-heading"><div><span className="section-kicker">QUICK ENTRY</span><h2>Record one payment</h2></div><p className="muted">Review before confirming. It cannot be edited afterwards.</p></div><form className="stack-form" onSubmit={submitSingle}><div className="form-grid"><SelectField label="Class" required value={classId} onChange={(value) => { setClassId(value); setStudentId(""); setCategoryId(""); }}><option value="">Choose class</option>{data.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField><TextField label="Search student" value={search} onChange={setSearch} placeholder="Name or admission number" /></div><SelectField label="Student" required value={studentId} onChange={setStudentId}><option value="">Choose student</option>{studentsInClass.slice(0, 100).map((student) => <option key={student.id} value={student.id}>{student.full_name} · {student.admission_no}</option>)}</SelectField><div className="form-grid"><SelectField label="Financial category" required value={categoryId} onChange={setCategoryId}><option value="">Choose category</option>{categoriesForClass.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</SelectField><TextField label="Amount paid (₦)" required type="number" min="0.01" step="0.01" value={amount} onChange={setAmount} placeholder="0.00" /></div><div className="form-grid"><SelectField label="Academic session" required value={sessionId} onChange={(value) => { setSessionId(value); setTermId(""); }}><option value="">Choose session</option>{data.sessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}</SelectField><SelectField label="Term (where applicable)" value={termId} onChange={setTermId}><option value="">Not term-specific</option>{sessionTerms.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}</SelectField></div><div className="form-grid"><TextField label="Payment date" required type="date" value={paymentDate} onChange={setPaymentDate} /><TextField label="Optional note" value={note} onChange={setNote} placeholder="Receipt note" /></div>{studentId && categoryId && <div className="review-box"><span className="section-kicker">CHECK BEFORE SAVING</span><strong>{data.students.find((student) => student.id === studentId)?.full_name}</strong><div><span>{data.categories.find((category) => category.id === categoryId)?.name}</span><b>{naira(amount)}</b></div></div>}<button className="button primary full" disabled={busy || !studentId || !categoryId}>{busy ? "Saving…" : "Confirm & lock payment"}</button></form></section>}
      {mode === "bat…2381 tokens truncated…nToast({ type: "success", message: "Handover submitted for Principal confirmation." });
    await onRefresh();
  }

  async function review(handoverId: string, decision: "confirm" | "reject") {
    if (decision === "reject" && decisionNote.trim().length < 3) { onToast({ type: "error", message: "Add a short query note before rejecting." }); return; }
    setBusy(true);
    const { error } = await client.rpc("review_handover", { p_handover_id: handoverId, p_decision: decision, p_decision_note: decisionNote.trim() || null });
    setBusy(false);
    if (error) { onToast({ type: "error", message: error.message }); return; }
    setDecisionNote("");
    onToast({ type: "success", message: decision === "confirm" ? "Money marked as received by Principal." : "Handover rejected and returned to staff custody." });
    await onRefresh();
  }

  return <div className="content-wrap"><PageHeader title="Money handover" description={data.profile.role === "principal" ? "Confirm the exact money that has reached the office." : "Select the exact payments still in your custody."} />
    {can("create_handover") && <section className="panel"><div className="panel-heading"><div><span className="section-kicker">STAFF CUSTODY</span><h2>Money still with me</h2></div><span className="muted">{custodyPayments.length} payment{custodyPayments.length === 1 ? "" : "s"} available</span></div>{custodyPayments.length ? <><div className="select-list">{custodyPayments.map((payment) => <label className="select-row" key={payment.id}><input type="checkbox" checked={selected.includes(payment.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, payment.id] : selected.filter((id) => id !== payment.id))} /><span><strong>{payment.student?.full_name || "Student"}</strong><small>{payment.category?.name} · {payment.reference_no}</small></span><b>{naira(payment.amount_paid)}</b></label>)}</div><div className="handover-submit"><div><span>Handover total</span><strong>{naira(selectedTotal)}</strong></div><button className="button primary" disabled={busy || !selected.length} onClick={() => void createHandover()}>{busy ? "Submitting…" : "Submit for confirmation"}</button></div></> : <EmptyState title="No money waiting for handover" text="New payments you record will appear here until they are handed over and confirmed." />}</section>}
    {data.profile.role !== "principal" && <section className="panel"><div className="panel-heading"><div><span className="section-kicker">MY HANDOVERS</span><h2>Submission history</h2></div></div><HandoverList data={data} ownOnly /></section>}
    {can("confirm_handovers") && <section className="panel"><div className="panel-heading"><div><span className="section-kicker">PRINCIPAL ACTION</span><h2>Pending handovers</h2></div><Badge tone={pending.length ? "warning" : "success"}>{pending.length} pending</Badge></div>{pending.length ? <div className="pending-handover-list">{pending.map((handover) => { const items = data.handoverItems.filter((item) => item.handover_id === handover.id); return <article className="pending-handover" key={handover.id}><div className="pending-handover-head"><div><strong>{handover.staff?.full_name || (data.staffProfiles.find((profile) => profile.id === handover.staff_id)?.full_name || "Staff member")}</strong><span>{dateTime(handover.submitted_at)} · {items.length} payment{items.length === 1 ? "" : "s"}</span></div><strong>{naira(handover.total_amount)}</strong></div><div className="mini-items">{items.map((item) => <div key={item.id}><span>{item.payment?.student?.full_name || "Student"} · {item.payment?.category?.name || "Category"}</span><b>{naira(item.amount)}</b></div>)}</div><textarea value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="Optional note, required for a query" /><div className="row-actions"><button className="button primary" disabled={busy} onClick={() => void review(handover.id, "confirm")}>✓ Confirm received</button><button className="button danger-outline" disabled={busy} onClick={() => void review(handover.id, "reject")}>Query / reject</button></div></article>; })}</div> : <EmptyState title="No handover is waiting" text="Submitted staff handovers will appear here for confirmation." />}</section>}
    {(data.handovers.some((handover) => handover.status !== "pending") && (data.profile.role === "principal" || can("view_all_collections"))) && <section className="panel"><div className="panel-heading"><div><span className="section-kicker">HANDOVER HISTORY</span><h2>Confirmed and queried</h2></div></div><HandoverList data={data} /></section>}
  </div>;
}

function HandoverList({ data, ownOnly = false }: { data: PortalData; ownOnly?: boolean }) {
  const rows = data.handovers.filter((handover) => !ownOnly || handover.staff_id === data.profile.id);
  return rows.length ? <div className="simple-list">{rows.map((handover) => <div className="simple-list-row" key={handover.id}><div><strong>{ownOnly ? "Handover" : (handover.staff?.full_name || data.staffProfiles.find((profile) => profile.id === handover.staff_id)?.full_name || "Staff")}</strong><span>{dateTime(handover.submitted_at)} · {handover.decision_note || "No note"}</span></div><div><b>{naira(handover.total_amount)}</b><Badge tone={handover.status === "confirmed" ? "success" : handover.status === "rejected" ? "danger" : "warning"}>{handover.status}</Badge></div></div>)}</div> : <p className="muted">No handover history yet.</p>;
}

function StudentsView({ data, can, client, onRefresh, onToast }: { data: PortalData; can: (permission: PermissionKey) => boolean; client: AnyClient; onRefresh: () => Promise<void>; onToast: (toast: NonNullable<Toast>) => void }) {
  const [search, setSearch] = useState("");
  const [classId, setClassId] = useState("");
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [importRows, setImportRows] = useState<Array<Record<string, string>>>([]);
  const [importError, setImportError] = useState("");
  const [busy, setBusy] = useState(false);
  const students = data.students.filter((student) => (!classId || student.class_id === classId) && `${student.full_name} ${student.admission_no}`.toLowerCase().includes(search.toLowerCase()));
  const sessionMap = new Map(data.sessions.map((session) => [session.id, session.name]));

  async function parseFile(file: File) {
    setImportError("");
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const normalized = rows.map((row) => Object.entries(row).reduce<Record<string, string>>((result, [key, value]) => { result[key.trim().toLowerCase().replaceAll(" ", "_")] = String(value ?? "").trim(); return result; }, {}));
      if (!normalized.length) throw new Error("The file has no rows.");
      setImportRows(normalized.slice(0, 500));
    } catch (error) { setImportError(messageFrom(error)); setImportRows([]); }
  }

  async function importStudents() {
    if (!importRows.length) return;
    const classMap = new Map(data.classes.map((item) => [item.name.toLowerCase(), item.id]));
    const sessionMapByName = new Map(data.sessions.map((item) => [item.name.toLowerCase(), item.id]));
    const rows = importRows.map((row) => ({ admission_no: row.admission_no, full_name: row.full_name, class_id: classMap.get((row.class || "").toLowerCase()), arm: row.arm || null, status: ["active", "inactive", "graduated", "withdrawn"].includes(row.status) ? row.status : "active", academic_session_id: sessionMapByName.get((row.academic_session || "").toLowerCase()) })).filter((row) => row.admission_no && row.full_name && row.class_id && row.academic_session_id);
    if (!rows.length) { onToast({ type: "error", message: "No valid rows found. Check the required headers and class/session names." }); return; }
    setBusy(true);
    const { error } = await client.from("students").insert(rows);
    setBusy(false);
    if (error) { onToast({ type: "error", message: error.message }); return; }
    onToast({ type: "success", message: `${rows.length} student records imported.` });
    setImportRows([]);
    await onRefresh();
  }

  function downloadTemplate() {
    const csv = ["admission_no,full_name,class,arm,status,academic_session", ""].join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = "ilawo-student-import-template.csv"; link.click(); URL.revokeObjectURL(link.href);
  }

  return <div className="content-wrap"><PageHeader title="Students" description="Keep the official student list and each student’s read-only payment ledger." action={can("manage_students") ? <button className="button secondary" onClick={downloadTemplate}>↓ CSV template</button> : undefined} />
    {can("manage_students") && <section className="panel import-panel"><div className="panel-heading"><div><span className="section-kicker">IMPORT CENTRE</span><h2>Add the real student list</h2></div><span className="muted">CSV or Excel · preview first</span></div><div className="import-actions"><label className="file-button">Choose CSV / Excel<input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => { const file = e.target.files?.[0]; if (file) void parseFile(file); }} /></label><span>Required: admission_no, full_name, class, academic_session</span></div>{importError && <p className="form-error">{importError}</p>}{importRows.length > 0 && <><div className="import-preview"><strong>Previewing {importRows.length} row{importRows.length === 1 ? "" : "s"}</strong>{importRows.slice(0, 4).map((row, index) => <div key={index}><span>{row.full_name || "Missing name"}</span><small>{row.admission_no} · {row.class} · {row.academic_session}</small></div>)}</div><button className="button primary" disabled={busy} onClick={() => void importStudents()}>{busy ? "Importing…" : "Import valid rows"}</button></>}</section>}
    <section className="panel"><div className="panel-heading"><div><span className="section-kicker">STUDENT REGISTER</span><h2>{data.students.length} student{data.students.length === 1 ? "" : "s"}</h2></div><div className="inline-fields"><input className="compact-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search student" /><select value={classId} onChange={(e) => setClassId(e.target.value)}><option value="">All classes</option>{data.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div>{students.length ? <div className="table-scroll"><table><thead><tr><th>Student</th><th>Class</th><th>Session</th><th>Status</th><th /></tr></thead><tbody>{students.map((student) => <tr key={student.id}><td><strong>{student.full_name}</strong><small>{student.admission_no}</small></td><td>{student.class?.name || data.classes.find((item) => item.id === student.class_id)?.name}{student.arm ? ` · Arm ${student.arm}` : ""}</td><td>{sessionMap.get(student.academic_session_id) || "—"}</td><td><Badge tone={student.status === "active" ? "success" : "neutral"}>{student.status}</Badge></td><td><button className="small-button" onClick={() => setSelectedStudent(student)}>Open ledger</button></td></tr>)}</tbody></table></div> : <EmptyState title="No students yet" text="Import the school's real student list when it is ready. No placeholder students are stored." />}</section>
    {selectedStudent && <StudentLedger data={data} student={selectedStudent} onClose={() => setSelectedStudent(null)} />}
  </div>;
}

function StudentLedger({ data, student, onClose }: { data: PortalData; student: Student; onClose: () => void }) {
  const payments = data.payments.filter((payment) => payment.student_id === student.id);
  return <Modal title={`${student.full_name}'s ledger`} onClose={onClose}><div className="student-profile"><div className="avatar large">{initials(student.full_name)}</div><div><strong>{student.full_name}</strong><span>{student.admission_no} · {student.class?.name || data.classes.find((item) => item.id === student.class_id)?.name}</span></div></div><div className="ledger-summary"><div><span>Paid so far</span><strong>{naira(payments.reduce((sum, payment) => sum + numberValue(payment.amount_paid), 0))}</strong></div><div><span>Payment records</span><strong>{payments.length}</strong></div></div>{payments.length ? <div className="simple-list">{payments.map((payment) => <div className="simple-list-row" key={payment.id}><div><strong>{payment.category?.name}</strong><span>{shortDate(payment.payment_date)} · {payment.reference_no}</span></div><b>{naira(payment.amount_paid)}</b></div>)}</div> : <p className="muted">No payment has been recorded for this student.</p>}<p className="helper-line">Expected charges and balances appear after the Principal configures amounts for this class, session and term.</p></Modal>;
}

function CategoriesView({ data, client, onRefresh, onToast }: { data: PortalData; client: AnyClient; onRefresh: () => Promise<void>; onToast: (toast: NonNullable<Toast>) => void }) {
  const [name, setName] = useState("");
  const [applicableToTerm, setApplicableToTerm] = useState(true);
  const [classIds, setClassIds] = useState<string[]>([]);
  const [chargeCategory, setChargeCategory] = useState("");
  const [chargeClass, setChargeClass] = useState("");
  const [chargeSession, setChargeSession] = useState(data.sessions.find((session) => session.active)?.id || data.sessions[0]?.id || "");
  const [chargeTerm, setChargeTerm] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const currentTerms = data.terms.filter((term) => term.session_id === chargeSession);

  async function addCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!name.trim() || !classIds.length) return;
    setBusy(true);
    const { data: category, error } = await client.from("financial_categories").insert({ name: name.trim(), applicable_to_term: applicableToTerm, active: true }).select("id").single();
    if (!error && category) { const { error: classError } = await client.from("financial_category_classes").insert(classIds.map((classId) => ({ category_id: category.id, class_id: classId }))); if (classError) { setBusy(false); onToast({ type: "error", message: classError.message }); return; } }
    setBusy(false); if (error) { onToast({ type: "error", message: error.message }); return; }
    setName(""); setClassIds([]); onToast({ type: "success", message: "Financial category added." }); await onRefresh();
  }

  async function addCharge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!chargeCategory || !chargeClass || !chargeSession || numberValue(chargeAmount) < 0) return;
    setBusy(true);
    const existing = data.charges.find((charge) => charge.category_id === chargeCategory && charge.class_id === chargeClass && charge.session_id === chargeSession && (charge.term_id || null) === (chargeTerm || null));
    const result = existing
      ? await client.from("expected_charges").update({ expected_amount: numberValue(chargeAmount), active: true }).eq("id", existing.id)
      : await client.from("expected_charges").insert({ category_id: chargeCategory, class_id: chargeClass, session_id: chargeSession, term_id: chargeTerm || null, expected_amount: numberValue(chargeAmount), active: true });
    const { error } = result;
    setBusy(false); if (error) { onToast({ type: "error", message: error.message }); return; }
    setChargeAmount(""); onToast({ type: "success", message: "Expected charge saved." }); await onRefresh();
  }

  async function toggleCategory(category: FinancialCategory) {
    const { error } = await client.from("financial_categories").update({ active: !category.active }).eq("id", category.id);
    if (error) onToast({ type: "error", message: error.message }); else { onToast({ type: "success", message: `${category.name} ${category.active ? "deactivated" : "activated"}.` }); await onRefresh(); }
  }

  return <div className="content-wrap"><PageHeader title="Financial categories" description="Add future charges without changing the portal’s code." /><div className="two-column"><section className="panel form-panel"><div className="panel-heading"><div><span className="section-kicker">NEW CATEGORY</span><h2>Add a charge type</h2></div></div><form className="stack-form" onSubmit={addCategory}><TextField label="Category name" required value={name} onChange={setName} placeholder="e.g. PTA levy" /><label className="check-line"><input type="checkbox" checked={applicableToTerm} onChange={(e) => setApplicableToTerm(e.target.checked)} /> Applies to a term</label><div className="class-picker"><span className="field-label">Applicable classes</span><div className="check-grid">{data.classes.map((item) => <label key={item.id}><input type="checkbox" checked={classIds.includes(item.id)} onChange={(e) => setClassIds(e.target.checked ? [...classIds, item.id] : classIds.filter((id) => id !== item.id))} />{item.name}</label>)}</div></div><button className="button primary full" disabled={busy}>Add category</button></form></section><section className="panel form-panel"><div className="panel-heading"><div><span className="section-kicker">EXPECTED AMOUNT</span><h2>Configure a charge</h2></div></div><form className="stack-form" onSubmit={addCharge}><SelectField label="Category" required value={chargeCategory} onChange={setChargeCategory}><option value="">Choose category</option>{data.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</SelectField><div className="form-grid"><SelectField label="Class" required value={chargeClass} onChange={setChargeClass}><option value="">Choose class</option>{data.classes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</SelectField><TextField label="Expected amount (₦)" required type="number" min="0" step="0.01" value={chargeAmount} onChange={setChargeAmount} placeholder="0.00" /></div><SelectField label="Session" required value={chargeSession} onChange={(value) => { setChargeSession(value); setChargeTerm(""); }}><option value="">Choose session</option>{data.sessions.map((session) => <option key={session.id} value={session.id}>{session.name}</option>)}</SelectField><SelectField label="Term" value={chargeTerm} onChange={setChargeTerm}><option value="">All session / non-term</option>{currentTerms.map((term) => <option key={term.id} value={term.id}>{term.name}</option>)}</SelectField><button className="button secondary full" disabled={busy}>Save expected amount</button></form></section></div><section className="panel"><div className="panel-heading"><div><span className="section-kicker">CONFIGURED CATEGORIES</span><h2>{data.categories.length} categories</h2></div></div><div className="category-admin-list">{data.categories.map((category) => { const classNames = data.categoryClasses.filter((item) => item.category_id === category.id).map((item) => data.classes.find((schoolClass) => schoolClass.id === item.class_id)?.name).filter(Boolean); return <div className="category-admin-row" key={category.id}><div><strong>{category.name}</strong><span>{classNames.join(" · ") || "No class selected"} · {category.applicable_to_term ? "Term-based" : "Session-based"}</span></div><div className="row-actions"><Badge tone={category.active ? "success" : "neutral"}>{category.active ? "Active" : "Inactive"}</Badge><button className="small-button" onClick={() => void toggleCategory(category)}>{category.active ? "Deactivate" : "Activate"}</button></div></div>; })}</div></section></div>;
}

function StaffView({ data, client, onRefresh, onToast }: { data: PortalData; client: AnyClient; onRefresh: () => Promise<void>; onToast: (toast: NonNullable<Toast>) => void }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] = useState<PermissionKey[]>(["record_student_payments", "view_students", "view_own_collections", "create_handover"]);
  const [busy, setBusy] = useState(false);
  const staff = data.staffProfiles.filter((profile) => profile.role === "staff");

  async function staffRequest(body: Record<string, unknown>) {
    setBusy(true);
    const response = await fetch("/api/admin/staff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({})); setBusy(false);
    if (!response.ok) { onToast({ type: "error", message: result.error || "Staff action failed." }); return false; }
    return true;
  }

  async function createStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await staffRequest({ action: "create", fullName, email, password, permissions })) { setFullName(""); setEmail(""); setPassword(""); onToast({ type: "success", message: "Staff account created." }); await onRefresh(); }
  }

  async function toggle(profile: Profile) {
    if (await staffRequest({ action: "toggle", userId: profile.id, active: !profile.active })) { onToast({ type: "success", message: `${profile.full_name} ${profile.active ? "disabled" : "activated"}.` }); await onRefresh(); }
  }

  async function resetPassword(profile: Profile) {
    const nextPassword = window.prompt(`New temporary password for ${profile.full_name}:`);
    if (!nextPassword) return;
    if (await staffRequest({ action: "reset-password", userId: profile.id, password: nextPassword })) onToast({ type: "success", message: "Temporary password reset." });
  }

  async function editPermissions(profile: Profile) {
    const current = new Set(data.staffPermissionMap[profile.id] || []);
    const selected = permissionOptions.filter((option) => window.confirm(`${option.label}\n\n${option.description}\n\nPress OK to grant this permission, Cancel to leave it off.`) || current.has(option.key)).map((option) => option.key);
    if (await staffRequest({ action: "permissions", userId: profile.id, permissions: selected })) { onToast({ type: "success", message: "Permissions updated." }); await onRefresh(); }
  }

  return <div className="content-wrap"><PageHeader title="Staff & access" description="Create staff accounts and give only the access each person needs." /><div className="two-column"><section className="panel form-panel"><div className="panel-heading"><div><span className="section-kicker">NEW STAFF ACCOUNT</span><h2>Create a staff login</h2></div></div><form className="stack-form" onSubmit={createStaff}><TextField label="Staff name" required value={fullName} onChange={setFullName} placeholder="Full name" /><TextField label="Login email" required type="email" value={email} onChange={setEmail} placeholder="staff@example.com" /><TextField label="Temporary password" required type="password" value={password} onChange={setPassword} placeholder="At least 8 characters" /><div className="permission-picker"><span className="field-label">Permissions</span>{permissionOptions.map((option) => <label key={option.key} className="permission-line"><input type="checkbox" checked={permissions.includes(option.key)} onChange={(e) => setPermissions(e.target.checked ? [...permissions, option.key] : permissions.filter((item) => item !== option.key))} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</div><button className="button primary full" disabled={busy}>{busy ? "Creating…" : "Create staff account"}</button></form></section><section className="panel"><div className="panel-heading"><div><span className="section-kicker">STAFF ACCOUNTS</span><h2>{staff.length} staff member{staff.length === 1 ? "" : "s"}</h2></div></div>{staff.length ? <div className="staff-list">{staff.map((profile) => <div className="staff-row" key={profile.id}><div className="avatar">{initials(profile.full_name)}</div><div className="staff-main"><strong>{profile.full_name}</strong><span>{profile.email || "No email"} · {profile.staff_code || "No code"}</span><div className="permission-pills">{(data.staffPermissionMap[profile.id] || []).slice(0, 4).map((key) => <span key={key}>{permissionOptions.find((option) => option.key === key)?.label || key}</span>)}</div></div><div className="staff-actions"><Badge tone={profile.active ? "success" : "danger"}>{profile.active ? "Active" : "Disabled"}</Badge><button className="small-button" onClick={() => void toggle(profile)}>{profile.active ? "Disable" : "Activate"}</button><button className="small-button" onClick={() => void editPermissions(profile)}>Permissions</button><button className="small-button" onClick={() => void resetPassword(profile)}>Reset password</button></div></div>)}</div> : <EmptyState title="No staff accounts" text="Create the first staff account after the Principal has been set up." />}</section></div><section className="panel security-note"><span className="section-kicker">ACCESS RULE</span><h2>The database enforces these permissions.</h2><p>Removing a button is not the security boundary. Every exposed table and financial action is protected by Supabase RLS and database functions.</p></section></div>;
}

function PersonalBusinessView({ data, client, onRefresh, onToast }: { data: PortalData; client: AnyClient; onRefresh: () => Promise<void>; onToast: (toast: NonNullable<Toast>) => void }) {
  const [productName, setProductName] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [saleProduct, setSaleProduct] = useState("");
  const [saleQuantity, setSaleQuantity] = useState("1");
  const [salePrice, setSalePrice] = useState("");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const revenue = data.personalSales.reduce((sum, sale) => sum + sale.quantity * numberValue(sale.unit_price), 0);
  const cogs = data.personalSales.reduce((sum, sale) => sum + sale.quantity * numberValue(sale.unit_cost), 0);
  const expenses = data.personalExpenses.reduce((sum, expense) => sum + numberValue(expense.amount), 0);
  const selectedProduct = data.personalProducts.find((product) => product.id === saleProduct);

  async function addProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); const { error } = await client.from("personal_products").insert({ name: productName.trim(), cost_price: numberValue(costPrice), selling_price: numberValue(sellingPrice), quantity: Number(quantity) }); setBusy(false); if (error) { onToast({ type: "error", message: error.message }); return; } setProductName(""); setCostPrice(""); setSellingPrice(""); setQuantity(""); onToast({ type: "success", message: "Personal product added." }); await onRefresh();
  }
  async function addSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!saleProduct) return; setBusy(true); const { error } = await client.rpc("record_personal_sale", { p_product_id: saleProduct, p_quantity: Number(saleQuantity), p_unit_price: numberValue(salePrice || String(selectedProduct?.selling_price || 0)), p_note: null }); setBusy(false); if (error) { onToast({ type: "error", message: error.message }); return; } setSaleQuantity("1"); setSalePrice(""); onToast({ type: "success", message: "Personal sale recorded and stock reduced." }); await onRefresh();
  }
  async function addExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); const { error } = await client.from("personal_expenses").insert({ description: expenseDescription.trim(), amount: numberValue(expenseAmount) }); setBusy(false); if (error) { onToast({ type: "error", message: error.message }); return; } setExpenseDescription(""); setExpenseAmount(""); onToast({ type: "success", message: "Personal expense recorded." }); await onRefresh();
  }
  async function updateProduct(product: PersonalProduct, field: "quantity" | "cost_price" | "selling_price", value: string) { const { error } = await client.from("personal_products").update({ [field]: field === "quantity" ? Number(value) : numberValue(value) }).eq("id", product.id); if (error) onToast({ type: "error", message: error.message }); else await onRefresh(); }

  return <div className="content-wrap"><PageHeader title="Personal Business" description="Private school-side sales for the Principal. This balance never mixes with school money." action={<Badge tone="warning">Principal only</Badge>} /><div className="metric-grid personal-metrics"><MetricCard label="Revenue" value={naira(revenue)} helper="Personal sales" tone="teal" /><MetricCard label="Cost of goods sold" value={naira(cogs)} helper="Snapshot cost at sale" tone="gold" /><MetricCard label="Gross profit" value={naira(revenue - cogs)} helper="Revenue less COGS" tone="ink" /><MetricCard label="Estimated net profit" value={naira(revenue - cogs - expenses)} helper={`After ${naira(expenses)} expenses`} tone="rose" /></div><div className="three-column"><section className="panel form-panel"><div className="panel-heading"><div><span className="section-kicker">INVENTORY</span><h2>Add item</h2></div></div><form className="stack-form" onSubmit={addProduct}><TextField label="Product / item" required value={productName} onChange={setProductName} placeholder="Chin-chin, drinks…" /><div className="form-grid"><TextField label="Cost price" required type="number" min="0" step="0.01" value={costPrice} onChange={setCostPrice} placeholder="₦ 0" /><TextField label="Selling price" required type="number" min="0" step="0.01" value={sellingPrice} onChange={setSellingPrice} placeholder="₦ 0" /></div><TextField label="Opening quantity" required type="number" min="0" step="1" value={quantity} onChange={setQuantity} placeholder="0" /><button className="button primary full" disabled={busy}>Add item</button></form></section><section className="panel form-panel"><div className="panel-heading"><div><span className="section-kicker">SALE</span><h2>Record sale</h2></div></div><form className="stack-form" onSubmit={addSale}><SelectField label="Product" required value={saleProduct} onChange={setSaleProduct}><option value="">Choose item</option>{data.personalProducts.filter((product) => product.active).map((product) => <option key={product.id} value={product.id}>{product.name} · {product.quantity} in stock</option>)}</SelectField><div className="form-grid"><TextField label="Quantity" required type="number" min="1" step="1" value={saleQuantity} onChange={setSaleQuantity} /><TextField label="Selling price" type="number" min="0" step="0.01" value={salePrice} onChange={setSalePrice} placeholder={selectedProduct ? String(selectedProduct.selling_price) : "₦ 0"} /></div><p className="helper-line">The cost price is snapshotted and stock reduces together with the sale.</p><button className="button secondary full" disabled={busy || !saleProduct}>Record personal sale</button></form></section><section className="panel form-panel"><div className="panel-heading"><div><span className="section-kicker">EXPENSE</span><h2>Record expense</h2></div></div><form className="stack-form" onSubmit={addExpense}><TextField label="What was it for?" required value={expenseDescription} onChange={setExpenseDescription} placeholder="Packaging, transport…" /><TextField label="Amount" required type="number" min="0.01" step="0.01" value={expenseAmount} onChange={setExpenseAmount} placeholder="₦ 0" /><button className="button ghost full" disabled={busy}>Add personal expense</button></form></section></div><section className="panel"><div className="panel-heading"><div><span className="section-kicker">PERSONAL STOCK</span><h2>Items on hand</h2></div></div>{data.personalProducts.length ? <div className="table-scroll"><table><thead><tr><th>Item</th><th>Cost</th><th>Price</th><th>Quantity</th><th /></tr></thead><tbody>{data.personalProducts.map((product) => <tr key={product.id}><td><strong>{product.name}</strong></td><td>{naira(product.cost_price)}</td><td>{naira(product.selling_price)}</td><td><input className="table-input" type="number" min="0" value={product.quantity} onChange={(e) => void updateProduct(product, "quantity", e.target.value)} /></td><td>{product.quantity <= 2 && <Badge tone="warning">Low stock</Badge>}</td></tr>)}</tbody></table></div> : <EmptyState title="No personal items" text="Add the first product or item above." />}</section><section className="panel"><div className="panel-heading"><div><span className="section-kicker">RECENT PERSONAL SALES</span><h2>Sales activity</h2></div></div>{data.personalSales.length ? <div className="simple-list">{data.personalSales.slice(0, 10).map((sale) => <div className="simple-list-row" key={sale.id}><div><strong>{sale.product?.name || "Item"}</strong><span>{sale.quantity} × {naira(sale.unit_price)} · {shortDate(sale.sold_at)}</span></div><b>{naira(sale.quantity * numberValue(sale.unit_price))}</b></div>)}</div> : <p className="muted">No personal sales yet.</p>}</section></div>;
}

function AuditView({ data }: { data: PortalData }) {
  return <div className="content-wrap"><PageHeader title="Audit trail" description="Important financial and access actions are retained for review." /><section className="panel"><div className="panel-heading"><div><span className="section-kicker">IMMUTABLE ACTIVITY</span><h2>{data.auditLogs.length} log entr{data.auditLogs.length === 1 ? "y" : "ies"}</h2></div><Badge tone="info">Read-only</Badge></div>{data.auditLogs.length ? <div className="audit-list">{data.auditLogs.map((log) => <div className="audit-row" key={log.id}><div className="audit-dot" /><div><strong>{log.action.replaceAll(".", " · ")}</strong><span>{log.record_type}{log.record_id ? ` · ${log.record_id.slice(0, 8).toUpperCase()}` : ""}</span></div><time>{dateTime(log.created_at)}</time></div>)}</div> : <EmptyState title="No audit entries yet" text="Payment, correction and handover activity will appear here." />}</section></div>;
}

export default function PortalShell() {
  const configured = isSupabaseConfigured();
  const [client, setClient] = useState<AnyClient | null>(null);
  const [sessionUser, setSessionUser] = useState<User | null>(null);
  const [data, setData] = useState<PortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [toast, setToast] = useState<Toast>(null);

  const refresh = useCallback(async (supabase: AnyClient, user: User) => {
    setLoadError("");
    try {
      const portalData = await loadPortalData(supabase, user);
      setData(portalData);
    } catch (error) {
      console.error("Portal data load failed", error);
      setLoadError(messageFrom(error));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient() as AnyClient | null;
    setClient(supabase);
    if (!supabase) { setLoading(false); return; }
    let mounted = true;
    supabase.auth.getSession().then(({ data: authData }) => {
      if (!mounted) return;
      const user = authData.session?.user || null;
      setSessionUser(user);
      if (user) void refresh(supabase, user);
      else setLoading(false);
    });
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, authSession) => {
      if (!mounted) return;
      const user = authSession?.user || null;
      setSessionUser(user);
      if (user) void refresh(supabase, user);
      else { setData(null); setLoading(false); }
    });
    return () => { mounted = false; authListener.subscription.unsubscribe(); };
  }, [refresh]);

  useEffect(() => { if (toast) { const timeout = window.setTimeout(() => setToast(null), 4500); return () => window.clearTimeout(timeout); } }, [toast]);

  if (!sessionUser || !client) return <LoginScreen client={client} configured={configured} />;
  if (loading) return <main className="loading-page"><SchoolBrand compact /><div className="loading-spinner" /><p>Loading the secure finance workspace…</p></main>;
  if (loadError || !data) return <main className="loading-page"><SchoolBrand compact /><div className="setup-alert"><strong>Workspace could not be loaded</strong><p>{loadError || "Your profile is not ready yet."}</p><p>Confirm the database migration and that your Principal/Staff profile is active.</p></div><button className="button ghost" onClick={() => void client.auth.signOut()}>Return to login</button></main>;

  const readyClient = client as AnyClient;
  const readyUser = sessionUser as User;
  const can = (permission: PermissionKey) => data.profile.role === "principal" || data.permissions.some((item) => item.key === permission);
  const visibleNav = navItems.filter((item) => {
    if (!item.permission || item.id === "overview") return true;
    if (item.id === "payments") return can("record_student_payments") || can("view_own_collections") || can("view_all_collections");
    if (item.id === "handover") return can("create_handover") || can("confirm_handovers");
    if (item.id === "students") return can("view_students") || can("manage_students");
    return can(item.permission);
  });

  async function logout() { await readyClient.auth.signOut(); }
  async function reload() { await refresh(readyClient, readyUser); }
  function notify(nextToast: NonNullable<Toast>) { setToast(nextToast); }
  function go(tab: Tab) { setActiveTab(tab); window.scrollTo({ top: 0, behavior: "smooth" }); }

  return <div className="portal-layout"><aside className="sidebar"><SchoolBrand /><div className="sidebar-rule" /><p className="nav-caption">WORKSPACE</p><nav className="side-nav">{visibleNav.map((item) => <button key={item.id} className={activeTab === item.id ? "active" : ""} onClick={() => go(item.id)}><span className="nav-icon">{item.icon}</span>{item.label}</button>)}</nav><div className="sidebar-bottom"><div className="signed-user"><div className="avatar">{initials(data.profile.full_name)}</div><div><strong>{data.profile.full_name}</strong><span>{data.profile.role === "principal" ? "Principal / Admin" : "Staff account"}</span></div></div><button className="logout-button" onClick={() => void logout()}>Sign out</button></div></aside><main className="main-content"><header className="mobile-topbar"><SchoolBrand compact /><button className="logout-button" onClick={() => void logout()}>Sign out</button></header>{toast && <div className={`toast ${toast.type}`} role="status"><span>{toast.type === "success" ? "✓" : toast.type === "error" ? "!" : "i"}</span>{toast.message}<button onClick={() => setToast(null)}>×</button></div>}{activeTab === "overview" && <OverviewView data={data} can={can} onGo={go} onRefresh={reload} />}{activeTab === "payments" && <PaymentsView data={data} can={can} client={readyClient} onRefresh={reload} onToast={notify} />}{activeTab === "handover" && <HandoverView data={data} can={can} client={readyClient} onRefresh={reload} onToast={notify} />}{activeTab === "students" && <StudentsView data={data} can={can} client={readyClient} onRefresh={reload} onToast={notify} />}{activeTab === "categories" && <CategoriesView data={data} client={readyClient} onRefresh={reload} onToast={notify} />}{activeTab === "staff" && <StaffView data={data} client={readyClient} onRefresh={reload} onToast={notify} />}{activeTab === "personal" && <PersonalBusinessView data={data} client={readyClient} onRefresh={reload} onToast={notify} />}{activeTab === "audit" && <AuditView data={data} />}</main><nav className="mobile-nav">{visibleNav.slice(0, 5).map((item) => <button key={item.id} className={activeTab === item.id ? "active" : ""} onClick={() => go(item.id)}><span>{item.icon}</span>{item.label.split(" ")[0]}</button>)}</nav></div>;
}
