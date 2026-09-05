"use client";

import Image from "next/image";
import * as XLSX from "xlsx";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient, isSupabaseConfigured } from "@/lib/supabase-browser";
import { naira, numberValue, shortDate, todayISO } from "@/lib/format";

type AnyClient = SupabaseClient<any>;
type R = Record<string, any>;
type Tab = "home" | "record" | "classes" | "reports" | "settings";
type Toast = { type: "success" | "error" | "info"; message: string } | null;
type Data = {
  profile: R;
  classes: R[];
  sessions: R[];
  terms: R[];
  categories: R[];
  categoryClasses: R[];
  students: R[];
  charges: R[];
  payments: R[];
  expenses: R[];
  candidates: R[];
  external: R[];
  externalPayments: R[];
  settings: R | null;
};

type ImportRow = {
  admission_no: string;
  full_name: string;
  class_name: string;
  arm?: string;
  guardian_name?: string;
  guardian_phone?: string;
  guardian_email?: string;
  error?: string;
};

const nav: [Tab, string, string][] = [
  ["home", "Home", "⌂"],
  ["record", "Record", "＋"],
  ["classes", "Classes", "☷"],
  ["reports", "Reports", "▤"],
  ["settings", "Settings", "⚙"],
];

const expenseTypes = [
  "Registration / Remittance",
  "Logistics / Transport",
  "Printing",
  "Bank Charges",
  "Materials",
  "Administrative Expense",
  "Refund",
  "Other",
];

const message = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as any).message) : "Something went wrong.";

async function opt(c: AnyClient, table: string) {
  const { data, error } = await c.from(table).select("*");
  if (error) {
    console.warn(`${table}: ${error.message}`);
    return [];
  }
  return data || [];
}

function basis(c: R) {
  return (c.basis || (c.applicable_to_term ? "term" : "session")) as "term" | "session" | "one_off";
}

function candidateScope(c: R) {
  if (c.candidate_scope) return c.candidate_scope as "mixed" | "internal_only";
  return ["WAEC", "NECO"].includes(String(c.name || "").toUpperCase()) ? "mixed" : "internal_only";
}

function categoryName(c: R) {
  return String(c.name || "").toUpperCase() === "JUPEB" ? "U.P.E" : String(c.name || "");
}

function isMixed(c: R) {
  return candidateScope(c) === "mixed";
}

function current(d: Data) {
  const session = d.sessions.find((s) => s.id === d.settings?.current_session_id) || d.sessions.find((s) => s.active) || d.sessions[0];
  const term =
    d.terms.find((t) => t.id === d.settings?.current_term_id) ||
    d.terms.find((t) => t.session_id === session?.id && t.active) ||
    d.terms.find((t) => t.session_id === session?.id);
  return { session, term };
}

function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`school-brand ${small ? "compact" : ""}`}>
      <Image src="/ilawo-mark.svg" alt="Ilawo Community Grammar School" width={small ? 42 : 48} height={small ? 42 : 48} />
      <div>
        <p className="brand-name">ILAWO COMMUNITY GRAMMAR SCHOOL</p>
        <p className="brand-location">ILAWO · KNOWLEDGE IS LIGHT</p>
      </div>
    </div>
  );
}

function Header({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <span className="section-kicker">OFFICE OF THE PRINCIPAL</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function Metric({ label, value, helper, tone = "teal" }: { label: string; value: string; helper?: string; tone?: "teal" | "gold" | "ink" | "rose" }) {
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

function Select({ label, value, onChange, children, required = false }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode; required?: boolean }) {
  return (
    <label className="field-label">
      {label}
      <select required={required} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function Input({ label, value, onChange, type = "text", placeholder, required = false }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; required?: boolean }) {
  return (
    <label className="field-label">
      {label}
      <input
        required={required}
        type={type}
        min={type === "number" ? "0.01" : undefined}
        step={type === "number" ? "0.01" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function inDateRange(date: string, from?: string, to?: string) {
  if (!date) return true;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function catSummary(d: Data, c: R, sessionId: string, termId: string, from?: string, to?: string) {
  const b = basis(c);
  const mixed = isMixed(c);
  const classIds = new Set(d.categoryClasses.filter((x) => x.category_id === c.id).map((x) => x.class_id));
  let internal = d.students.filter((s) => s.status === "active" && s.academic_session_id === sessionId && classIds.has(s.class_id));
  const selectedCandidates = d.candidates.filter((x) => x.category_id === c.id && x.session_id === sessionId);

  // WAEC and NECO registrations are explicit: only selected internal candidates count.
  if (mixed) {
    const ids = new Set(selectedCandidates.map((x) => x.student_id));
    internal = internal.filter((s) => ids.has(s.id));
  }

  const allInternalPayments = d.payments.filter(
    (p) => p.category_id === c.id && p.session_id === sessionId && (b !== "term" || p.term_id === termId),
  );
  const ip = allInternalPayments.filter((p) => inDateRange(p.payment_date, from, to));

  const ext = mixed ? d.external.filter((x) => x.active && x.category_id === c.id && x.session_id === sessionId) : [];
  const allExternalPayments = mixed ? d.externalPayments.filter((p) => p.category_id === c.id && p.session_id === sessionId) : [];
  const ep = allExternalPayments.filter((p) => inDateRange(p.payment_date, from, to));
  const allExpenses = d.expenses.filter((e) => e.category_id === c.id && e.session_id === sessionId && (b !== "term" || e.term_id === termId));
  const exps = allExpenses.filter((e) => inDateRange(e.expense_date, from, to));

  const paid = new Map<string, number>();
  allInternalPayments.forEach((p) => paid.set(p.student_id, (paid.get(p.student_id) || 0) + numberValue(p.amount_paid)));
  let expected = 0;
  let fully = 0;
  let part = 0;
  let unpaid = 0;
  const statusRows: R[] = [];
  internal.forEach((s) => {
    const override = selectedCandidates.find((x) => x.student_id === s.id)?.expected_amount_override;
    const charge = d.charges.find(
      (x) =>
        x.active &&
        x.category_id === c.id &&
        x.class_id === s.class_id &&
        x.session_id === sessionId &&
        (b === "term" ? x.term_id === termId : !x.term_id),
    );
    const due = numberValue(override ?? charge?.expected_amount);
    if (due <= 0) return;
    expected += due;
    const got = paid.get(s.id) || 0;
    const status = got >= due ? "full" : got > 0 ? "part" : "unpaid";
    statusRows.push({ id: `internal-${s.id}`, name: s.full_name, admission_no: s.admission_no, type: "Internal", paid: got, due, status });
    if (status === "full") fully++;
    else if (status === "part") part++;
    else unpaid++;
  });

  const extPaid = new Map<string, number>();
  allExternalPayments.forEach((p) => extPaid.set(p.external_candidate_id, (extPaid.get(p.external_candidate_id) || 0) + numberValue(p.amount_paid)));
  let extExpected = 0;
  let extFully = 0;
  let extPart = 0;
  let extUnpaid = 0;
  ext.forEach((s) => {
    const due = numberValue(s.expected_amount);
    if (due <= 0) return;
    extExpected += due;
    const got = extPaid.get(s.id) || 0;
    const status = got >= due ? "full" : got > 0 ? "part" : "unpaid";
    statusRows.push({ id: `external-${s.id}`, name: s.full_name, admission_no: s.class_level || "External", type: "External", paid: got, due, status });
    if (status === "full") extFully++;
    else if (status === "part") extPart++;
    else extUnpaid++;
  });

  const periodCollected = allInternalPayments.reduce((a, p) => a + numberValue(p.amount_paid), 0) + allExternalPayments.reduce((a, p) => a + numberValue(p.amount_paid), 0);
  const collected = ip.reduce((a, p) => a + numberValue(p.amount_paid), 0) + ep.reduce((a, p) => a + numberValue(p.amount_paid), 0);
  const spent = exps.reduce((a, e) => a + numberValue(e.amount), 0);

  return {
    internal,
    ext,
    ip,
    ep,
    exps,
    expected: expected + extExpected,
    periodCollected,
    collected,
    spent,
    balance: collected - spent,
    outstanding: Math.max(expected + extExpected - periodCollected, 0),
    fully: fully + extFully,
    part: part + extPart,
    unpaid: unpaid + extUnpaid,
    internalCount: internal.length,
    externalCount: ext.length,
    statusRows: statusRows.sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
}

function Login({ c }: { c: AnyClient | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!c) return;
    setBusy(true);
    setError("");
    const r = await c.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (r.error) setError(r.error.message);
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Brand />
        <div className="auth-heading">
          <span className="section-kicker">OFFICE OF THE PRINCIPAL</span>
          <h1>Your school money record book.</h1>
          <p>See what was collected, what was spent and what remains.</p>
        </div>
        {!isSupabaseConfigured() ? (
          <div className="setup-alert">Portal setup is incomplete</div>
        ) : (
          <form className="stack-form" onSubmit={submit}>
            <Input label="Email" type="email" value={email} onChange={setEmail} required />
            <Input label="Password" type="password" value={password} onChange={setPassword} required />
            {error && <p className="form-error">{error}</p>}
            <button className="button primary full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        )}
      </section>
    </main>
  );
}

function Home({ d, go }: { d: Data; go: (t: Tab) => void }) {
  const { session, term } = current(d);
  const [open, setOpen] = useState<R | null>(null);
  const rows = d.categories.filter((c) => c.active).map((c) => ({ c, s: catSummary(d, c, session?.id || "", term?.id || "") }));
  const total = rows.reduce((a, r) => a + r.s.collected, 0);
  const spent = rows.reduce((a, r) => a + r.s.spent, 0);

  if (open) {
    const s = catSummary(d, open, session?.id || "", term?.id || "");
    const mixed = isMixed(open);
    return (
      <div className="content-wrap">
        <Header
          title={categoryName(open)}
          description={`${basis(open) === "term" && term ? term.name + " · " : ""}${session?.name || "Current session"}`}
          action={<button className="button ghost" onClick={() => setOpen(null)}>← Home</button>}
        />
        <div className="metric-grid">
          <Metric label="Collected" value={naira(s.periodCollected)} />
          <Metric label="Expenses" value={naira(s.spent)} tone="rose" />
          <Metric label="Net balance" value={naira(s.periodCollected - s.spent)} tone="ink" />
          <Metric label="Outstanding" value={s.expected ? naira(s.outstanding) : "—"} helper={s.expected ? `Expected ${naira(s.expected)}` : "Set an expected amount in Settings"} tone="gold" />
        </div>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <span className="section-kicker">{mixed ? "REGISTRATION ANALYSIS" : "STUDENT ANALYSIS"}</span>
              <h2>{mixed ? `${s.internalCount + s.externalCount} candidates` : `${s.internalCount} students`}</h2>
            </div>
          </div>
          <div className="status-counts">
            {mixed ? (
              <>
                <button><strong>{s.internalCount}</strong><span>Internal</span></button>
                <button><strong>{s.externalCount}</strong><span>External</span></button>
                <button><strong>{s.fully}</strong><span>Fully paid</span></button>
                <button><strong>{s.part}</strong><span>Partly paid</span></button>
                <button><strong>{s.unpaid}</strong><span>Not paid</span></button>
              </>
            ) : (
              <>
                <button><strong>{s.fully}</strong><span>Fully paid</span></button>
                <button><strong>{s.part}</strong><span>Partly paid</span></button>
                <button><strong>{s.unpaid}</strong><span>Not paid</span></button>
              </>
            )}
          </div>
          {mixed && <p className="helper-line">Only WAEC and NECO support both internal and external candidates. Their money is combined, while candidate counts remain separate.</p>}
          {s.statusRows.length > 0 && (
            <details style={{ marginTop: 18 }}>
              <summary className="text-button" style={{ cursor: "pointer" }}>View names and payment status ({s.statusRows.length})</summary>
              <div className="simple-list" style={{ marginTop: 12 }}>
                {s.statusRows.map((row: R) => (
                  <div className="simple-list-row" key={row.id}>
                    <div><strong>{row.name}</strong><span>{row.type}{row.admission_no ? ` · ${row.admission_no}` : ""} · Paid {naira(row.paid)} of {naira(row.due)}</span></div>
                    <Badge tone={row.status === "full" ? "success" : row.status === "part" ? "warning" : "danger"}>{row.status === "full" ? "Fully paid" : row.status === "part" ? "Partly paid" : "Not paid"}</Badge>
                  </div>
                ))}
              </div>
            </details>
          )}
          <div className="quick-actions" style={{ marginTop: 18 }}>
            <button className="button primary" onClick={() => go("record")}>Record money</button>
            <button className="button ghost" onClick={() => go("reports")}>View report</button>
          </div>
        </section>
        <div className="two-column">
          <section className="panel">
            <div className="panel-heading"><h2>Recent payments</h2></div>
            {([...s.ip.map((p: R) => ({ ...p, who: d.students.find((x) => x.id === p.student_id)?.full_name || "Student" })), ...s.ep.map((p: R) => ({ ...p, who: d.external.find((x) => x.id === p.external_candidate_id)?.full_name || "External candidate" }))] as R[])
              .sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)))
              .slice(0, 10)
              .map((p) => <div className="simple-list-row" key={p.id}><div><strong>{p.who}</strong><span>{shortDate(p.payment_date)}</span></div><b>{naira(p.amount_paid)}</b></div>)}
            {!s.ip.length && !s.ep.length && <p className="muted">No payments recorded yet.</p>}
          </section>
          <section className="panel">
            <div className="panel-heading"><h2>Recent expenses</h2></div>
            {s.exps.slice().sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date))).slice(0, 10).map((e) => (
              <div className="simple-list-row" key={e.id}><div><strong>{e.expense_type}</strong><span>{e.description || shortDate(e.expense_date)}</span></div><b>{naira(e.amount)}</b></div>
            ))}
            {!s.exps.length && <p className="muted">No expenses recorded yet.</p>}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="content-wrap">
      <Header title="Financial summary" description={`${term?.name ? term.name + " · " : ""}${session?.name || "Set the current period in Settings"}`} />
      <div className="metric-grid">
        <Metric label="Total collected" value={naira(total)} helper="All school collections" />
        <Metric label="Total expenses" value={naira(spent)} helper="All school expenses" tone="rose" />
        <Metric label="Net balance" value={naira(total - spent)} helper="Collected less expenses" tone="ink" />
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div><span className="section-kicker">BY CATEGORY</span><h2>Collections at a glance</h2></div>
          <button className="text-button" onClick={() => go("record")}>Record money →</button>
        </div>
        <div className="category-grid">
          {rows.map(({ c, s }) => {
            const mixed = isMixed(c);
            return (
              <button className="category-card" style={{ textAlign: "left", cursor: "pointer" }} key={c.id} onClick={() => setOpen(c)}>
                <div className="category-card-top"><h3>{categoryName(c)}</h3><Badge tone="info">{basis(c) === "term" ? "Term" : basis(c) === "session" ? "Session" : "Special"}</Badge></div>
                <strong>{naira(s.periodCollected)}</strong>
                <p>{mixed ? `${s.internalCount} internal · ${s.externalCount} external` : `${s.internalCount} internal students`}</p>
                <div className="category-footer"><span>Expenses {naira(s.spent)}</span><b>Balance {naira(s.periodCollected - s.spent)}</b></div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function Record({ d, c, reload, notify }: { d: Data; c: AnyClient; reload: () => Promise<void>; notify: (x: NonNullable<Toast>) => void }) {
  const { session, term } = current(d);
  const [mode, setMode] = useState<"payment" | "mass" | "external" | "expense" | "photo">("payment");
  const [cat, setCat] = useState("");
  const [cls, setCls] = useState("");
  const [student, setStudent] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState("");
  const [batch, setBatch] = useState<Record<string, string>>({});
  const [review, setReview] = useState(false);
  const [expenseType, setExpenseType] = useState(expenseTypes[0]);
  const [description, setDescription] = useState("");
  const [extName, setExtName] = useState("");
  const [extPhone, setExtPhone] = useState("");
  const [extSchool, setExtSchool] = useState("");
  const [extLevel, setExtLevel] = useState("SS3");
  const [extExpected, setExtExpected] = useState("");
  const [extCandidate, setExtCandidate] = useState("");
  const [busy, setBusy] = useState(false);

  const category = d.categories.find((x) => x.id === cat);
  const b = category ? basis(category) : "session";
  const mixed = category ? isMixed(category) : false;
  const allowed = new Set(d.categoryClasses.filter((x) => x.category_id === cat).map((x) => x.class_id));
  const classes = cat ? d.classes.filter((x) => allowed.has(x.id)) : d.classes;
  let students = d.students.filter((x) => x.status === "active" && x.academic_session_id === session?.id && (!cls || x.class_id === cls));
  if (mixed) {
    const registered = new Set(d.candidates.filter((x) => x.category_id === cat && x.session_id === session?.id).map((x) => x.student_id));
    students = students.filter((x) => registered.has(x.id));
  }
  const external = mixed ? d.external.filter((x) => x.active && x.category_id === cat && x.session_id === session?.id) : [];
  const ctx = { session_id: session?.id, term_id: b === "term" ? term?.id : null };

  async function pay(e: FormEvent) {
    e.preventDefault();
    if (!student || !cls || !cat || !session?.id) return;
    setBusy(true);
    const { error } = await c.from("student_payments").insert({ student_id: student, class_id: cls, category_id: cat, amount_paid: numberValue(amount), payment_date: date, ...ctx, note: note || null });
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: "Payment recorded successfully." });
    setStudent("");
    setAmount("");
    setNote("");
    await reload();
  }

  async function mass(e: FormEvent) {
    e.preventDefault();
    const rows = students.filter((s) => numberValue(batch[s.id]) > 0).map((s) => ({ student_id: s.id, class_id: s.class_id, category_id: cat, amount_paid: numberValue(batch[s.id]), payment_date: date, ...ctx, note: note || null }));
    if (!rows.length) return notify({ type: "info", message: "Enter an amount beside at least one student." });
    if (!review) { setReview(true); return; }
    setBusy(true);
    const { error } = await c.from("student_payments").insert(rows);
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: `${rows.length} payments recorded.` });
    setBatch({});
    setReview(false);
    await reload();
  }

  async function expense(e: FormEvent) {
    e.preventDefault();
    if (!cat || !session?.id) return;
    setBusy(true);
    const { error } = await c.from("school_expenses").insert({ category_id: cat, expense_type: expenseType, description: description || null, amount: numberValue(amount), expense_date: date, session_id: session.id, term_id: b === "term" ? term?.id : null, note: note || null });
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: "Expense recorded." });
    setAmount("");
    setDescription("");
    setNote("");
    await reload();
  }

  async function addExternal(e: FormEvent) {
    e.preventDefault();
    if (!cat || !session?.id || !mixed) return;
    setBusy(true);
    const { error } = await c.from("external_candidates").insert({ full_name: extName.trim(), phone: extPhone || null, source_school: extSchool || null, category_id: cat, session_id: session.id, class_level: extLevel, expected_amount: extExpected ? numberValue(extExpected) : null });
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: "External candidate added to this exam." });
    setExtName("");
    setExtPhone("");
    setExtSchool("");
    setExtExpected("");
    await reload();
  }

  async function payExternal(e: FormEvent) {
    e.preventDefault();
    if (!extCandidate || !cat || !session?.id || !mixed) return;
    setBusy(true);
    const { error } = await c.from("external_candidate_payments").insert({ external_candidate_id: extCandidate, category_id: cat, amount_paid: numberValue(amount), payment_date: date, session_id: session.id, note: note || null });
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: "External candidate payment recorded." });
    setAmount("");
    setNote("");
    await reload();
  }

  return (
    <div className="content-wrap">
      <Header title="Record" description="Choose what you want to record. Session and term are filled automatically." />
      <div className="mode-tabs">
        <button className={mode === "payment" ? "active" : ""} onClick={() => setMode("payment")}>Payment</button>
        <button className={mode === "mass" ? "active" : ""} onClick={() => setMode("mass")}>Mass record</button>
        <button className={mode === "external" ? "active" : ""} onClick={() => setMode("external")}>WAEC/NECO external</button>
        <button className={mode === "expense" ? "active" : ""} onClick={() => setMode("expense")}>Expense</button>
        <button className={mode === "photo" ? "active" : ""} onClick={() => setMode("photo")}>Photo sheet</button>
      </div>

      {mode === "payment" && (
        <section className="panel form-panel">
          <div className="panel-heading"><div><span className="section-kicker">INTERNAL STUDENT</span><h2>Record one payment</h2></div></div>
          <form className="stack-form" onSubmit={pay}>
            <div className="form-grid">
              <Select label="Category" value={cat} onChange={(v) => { setCat(v); setCls(""); setStudent(""); }} required>
                <option value="">Choose category</option>{d.categories.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{categoryName(x)}</option>)}
              </Select>
              <Select label="Class" value={cls} onChange={(v) => { setCls(v); setStudent(""); }} required>
                <option value="">Choose class</option>{classes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </div>
            <Select label="Student" value={student} onChange={setStudent} required>
              <option value="">Choose student</option>{students.map((x) => <option key={x.id} value={x.id}>{x.full_name} · {x.admission_no}</option>)}
            </Select>
            {mixed && cls && !students.length && <div className="setup-alert"><strong>No registered internal candidates found.</strong><p>Register WAEC/NECO internal candidates in Settings first.</p></div>}
            <div className="form-grid"><Input label="Amount paid (₦)" type="number" value={amount} onChange={setAmount} required /><Input label="Date" type="date" value={date} onChange={setDate} required /></div>
            <Input label="Note (optional)" value={note} onChange={setNote} />
            <button className="button primary full" disabled={busy || !student}>{busy ? "Saving…" : "Save payment"}</button>
          </form>
        </section>
      )}

      {mode === "mass" && (
        <section className="panel form-panel">
          <div className="panel-heading"><div><span className="section-kicker">INTERNAL STUDENTS</span><h2>Record several students</h2></div></div>
          <form className="stack-form" onSubmit={mass}>
            <div className="form-grid">
              <Select label="Category" value={cat} onChange={(v) => { setCat(v); setCls(""); setBatch({}); setReview(false); }} required>
                <option value="">Choose category</option>{d.categories.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{categoryName(x)}</option>)}
              </Select>
              <Select label="Class" value={cls} onChange={(v) => { setCls(v); setBatch({}); setReview(false); }} required>
                <option value="">Choose class</option>{classes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            </div>
            {cls && students.length > 0 ? (
              <div className="batch-list">{students.map((s) => <div className="batch-row" key={s.id}><div><strong>{s.full_name}</strong><span>{s.admission_no}</span></div><input type="number" min="0" step="0.01" placeholder="₦ 0" value={batch[s.id] || ""} onChange={(e) => { setBatch({ ...batch, [s.id]: e.target.value }); setReview(false); }} /></div>)}</div>
            ) : cls ? (
              <div className="setup-alert"><strong>{mixed ? "No registered internal candidates found." : `No internal students found in ${d.classes.find((x) => x.id === cls)?.name}.`}</strong><p>{mixed ? "Select WAEC/NECO internal candidates in Settings first." : "Add or import the class students in Classes."}</p></div>
            ) : <p className="muted">Choose a category and class. The complete student list will appear here.</p>}
            {review && <div className="review-box"><strong>{Object.values(batch).filter((v) => numberValue(v) > 0).length} students · {naira(Object.values(batch).reduce((a, v) => a + numberValue(v), 0))}</strong></div>}
            <button className="button primary full" disabled={busy || !cls || !cat || !students.length}>{review ? "Save all payments" : "Review entries"}</button>
          </form>
        </section>
      )}

      {mode === "external" && (
        <div className="two-column">
          <section className="panel form-panel">
            <div className="panel-heading"><div><span className="section-kicker">WAEC / NECO ONLY</span><h2>Add external candidate</h2></div></div>
            <form className="stack-form" onSubmit={addExternal}>
              <Select label="Exam" value={cat} onChange={setCat} required>
                <option value="">Choose WAEC or NECO</option>{d.categories.filter((x) => x.active && isMixed(x)).map((x) => <option key={x.id} value={x.id}>{categoryName(x)}</option>)}
              </Select>
              <Input label="Candidate name" value={extName} onChange={setExtName} required />
              <div className="form-grid"><Select label="Level" value={extLevel} onChange={setExtLevel}><option>SS2</option><option>SS3</option><option>Other</option></Select><Input label="Expected fee (optional)" type="number" value={extExpected} onChange={setExtExpected} /></div>
              <Input label="Phone (optional)" value={extPhone} onChange={setExtPhone} />
              <Input label="School / source (optional)" value={extSchool} onChange={setExtSchool} />
              <button className="button secondary full" disabled={busy || !cat}>Add external candidate</button>
            </form>
          </section>
          <section className="panel form-panel">
            <div className="panel-heading"><h2>Record external payment</h2></div>
            <form className="stack-form" onSubmit={payExternal}>
              <Select label="Exam" value={cat} onChange={(v) => { setCat(v); setExtCandidate(""); }} required>
                <option value="">Choose WAEC or NECO</option>{d.categories.filter((x) => x.active && isMixed(x)).map((x) => <option key={x.id} value={x.id}>{categoryName(x)}</option>)}
              </Select>
              <Select label="External candidate" value={extCandidate} onChange={setExtCandidate} required>
                <option value="">Choose candidate</option>{external.map((x) => <option key={x.id} value={x.id}>{x.full_name} · {x.class_level || "External"}</option>)}
              </Select>
              {cat && !external.length && <p className="muted">No external candidates have been added for this exam yet.</p>}
              <div className="form-grid"><Input label="Amount paid (₦)" type="number" value={amount} onChange={setAmount} required /><Input label="Date" type="date" value={date} onChange={setDate} required /></div>
              <Input label="Note (optional)" value={note} onChange={setNote} />
              <button className="button primary full" disabled={busy || !extCandidate}>Save external payment</button>
            </form>
          </section>
        </div>
      )}

      {mode === "expense" && (
        <section className="panel form-panel">
          <div className="panel-heading"><div><span className="section-kicker">SCHOOL EXPENSE</span><h2>Record money spent</h2></div></div>
          <form className="stack-form" onSubmit={expense}>
            <Select label="Which collection did this expense come from?" value={cat} onChange={setCat} required>
              <option value="">Choose category / fund</option>{d.categories.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{categoryName(x)}</option>)}
            </Select>
            <div className="form-grid"><Select label="Expense type" value={expenseType} onChange={setExpenseType}>{expenseTypes.map((x) => <option key={x}>{x}</option>)}</Select><Input label="Amount (₦)" type="number" value={amount} onChange={setAmount} required /></div>
            <Input label="Description" value={description} onChange={setDescription} placeholder="e.g. WAEC registration remittance" />
            <div className="form-grid"><Input label="Date" type="date" value={date} onChange={setDate} required /><Input label="Note / reference" value={note} onChange={setNote} /></div>
            <button className="button primary full" disabled={busy || !cat}>Save expense</button>
          </form>
        </section>
      )}

      {mode === "photo" && (
        <section className="panel form-panel">
          <div className="panel-heading"><div><span className="section-kicker">HANDWRITTEN SHEET</span><h2>Take or upload photo</h2></div><Badge tone="warning">Draft only</Badge></div>
          <label className="file-button">Take photo / choose image<input type="file" accept="image/*" capture="environment" /></label>
          <p className="helper-line">The photo workflow is prepared, but handwriting recognition is not yet connected. No photo will create a financial record until the Principal reviews extracted entries.</p>
        </section>
      )}
    </div>
  );
}

function Classes({ d, c, reload, notify }: { d: Data; c: AnyClient; reload: () => Promise<void>; notify: (x: NonNullable<Toast>) => void }) {
  const { session } = current(d);
  const [cls, setCls] = useState("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<R | null>(null);
  const [name, setName] = useState("");
  const [admission, setAdmission] = useState("");
  const [studentClass, setStudentClass] = useState(d.classes[0]?.id || "");
  const [arm, setArm] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [busy, setBusy] = useState(false);

  const rows = d.students
    .filter((s) => s.academic_session_id === session?.id && (cls === "all" || s.class_id === cls))
    .filter((s) => !search.trim() || `${s.full_name} ${s.admission_no} ${s.guardian_name || ""} ${s.guardian_phone || ""}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));

  function resetForm() {
    setEditing(null); setName(""); setAdmission(""); setStudentClass(d.classes[0]?.id || ""); setArm(""); setGuardianName(""); setGuardianPhone(""); setGuardianEmail("");
  }

  function edit(s: R) {
    setEditing(s); setName(s.full_name || ""); setAdmission(s.admission_no || ""); setStudentClass(s.class_id || d.classes[0]?.id || ""); setArm(s.arm || ""); setGuardianName(s.guardian_name || ""); setGuardianPhone(s.guardian_phone || ""); setGuardianEmail(s.guardian_email || "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveStudent(e: FormEvent) {
    e.preventDefault();
    if (!session?.id) return;
    setBusy(true);
    const payload = { full_name: name.trim(), admission_no: admission.trim(), class_id: studentClass, academic_session_id: session.id, arm: arm || null, guardian_name: guardianName || null, guardian_phone: guardianPhone || null, guardian_email: guardianEmail || null, status: "active" };
    const q = editing ? c.from("students").update(payload).eq("id", editing.id) : c.from("students").insert(payload);
    const { error } = await q;
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: editing ? "Student details updated." : "Student added." });
    resetForm();
    await reload();
  }

  async function parseFile(file: File) {
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: "" });
      const normalized: ImportRow[] = raw.map((r) => {
        const lower: Record<string, any> = {};
        Object.entries(r).forEach(([k, v]) => { lower[k.trim().toLowerCase().replace(/\s+/g, "_")] = v; });
        const row: ImportRow = {
          admission_no: String(lower.admission_no || lower.admission_number || "").trim(),
          full_name: String(lower.full_name || lower.student_name || lower.name || "").trim(),
          class_name: String(lower.class || lower.class_name || "").trim().toUpperCase(),
          arm: String(lower.arm || "").trim(),
          guardian_name: String(lower.guardian_name || lower.parent_name || "").trim(),
          guardian_phone: String(lower.guardian_phone || lower.parent_phone || lower.phone || "").trim(),
          guardian_email: String(lower.guardian_email || lower.parent_email || "").trim(),
        };
        if (!row.admission_no || !row.full_name || !d.classes.some((x) => x.name.toUpperCase() === row.class_name)) row.error = "Admission number, student name and a valid class are required.";
        return row;
      });
      setImportRows(normalized);
    } catch (e) {
      notify({ type: "error", message: message(e) });
    }
  }

  async function importStudents() {
    if (!session?.id) return;
    const valid = importRows.filter((r) => !r.error);
    if (!valid.length) return;
    setBusy(true);
    const payload = valid.map((r) => ({
      admission_no: r.admission_no,
      full_name: r.full_name,
      class_id: d.classes.find((x) => x.name.toUpperCase() === r.class_name)?.id,
      academic_session_id: session.id,
      arm: r.arm || null,
      guardian_name: r.guardian_name || null,
      guardian_phone: r.guardian_phone || null,
      guardian_email: r.guardian_email || null,
      status: "active",
    }));
    const { error } = await c.from("students").upsert(payload, { onConflict: "admission_no" });
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: `${valid.length} students imported into the master register.` });
    setImportRows([]);
    await reload();
  }

  return (
    <div className="content-wrap">
      <Header title="Classes & students" description="The master school register. External WAEC/NECO candidates are kept separately and never appear here." />
      <section className="panel form-panel">
        <div className="panel-heading"><div><span className="section-kicker">MASTER REGISTER</span><h2>{editing ? "Edit student" : "Add student"}</h2></div>{editing && <button className="button ghost" onClick={resetForm}>Cancel edit</button>}</div>
        <form className="stack-form" onSubmit={saveStudent}>
          <div className="form-grid"><Input label="Student name" value={name} onChange={setName} required /><Input label="Admission number" value={admission} onChange={setAdmission} required /></div>
          <div className="form-grid"><Select label="Class" value={studentClass} onChange={setStudentClass} required>{d.classes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select><Input label="Arm (optional)" value={arm} onChange={setArm} /></div>
          <div className="form-grid"><Input label="Parent / guardian name" value={guardianName} onChange={setGuardianName} /><Input label="Parent / guardian phone" value={guardianPhone} onChange={setGuardianPhone} /></div>
          <Input label="Parent / guardian email (optional)" type="email" value={guardianEmail} onChange={setGuardianEmail} />
          <button className="button primary" disabled={busy}>{editing ? "Save changes" : "Add student"}</button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="section-kicker">BULK IMPORT</span><h2>Import Excel or CSV</h2></div><a className="button ghost" href="/student-import-template.csv" download>Download template</a></div>
        <label className="file-button">Choose Excel / CSV<input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void parseFile(f); }} /></label>
        {importRows.length > 0 && <div style={{ marginTop: 18 }}><p className="helper-line">Preview: {importRows.length} rows · {importRows.filter((r) => !r.error).length} ready · {importRows.filter((r) => r.error).length} need attention</p><div className="table-scroll"><table><thead><tr><th>Admission</th><th>Name</th><th>Class</th><th>Guardian</th><th>Status</th></tr></thead><tbody>{importRows.slice(0, 20).map((r, i) => <tr key={`${r.admission_no}-${i}`}><td>{r.admission_no || "—"}</td><td>{r.full_name || "—"}</td><td>{r.class_name || "—"}</td><td>{r.guardian_name || "—"}</td><td>{r.error ? <Badge tone="danger">Fix row</Badge> : <Badge tone="success">Ready</Badge>}</td></tr>)}</tbody></table></div>{importRows.length > 20 && <p className="muted">Showing the first 20 rows. All valid rows will be imported.</p>}<button className="button primary" disabled={busy || !importRows.some((r) => !r.error)} onClick={() => void importStudents()}>Import valid students</button></div>}
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="section-kicker">STUDENT LIST</span><h2>{rows.length} students shown</h2></div></div>
        <div className="form-grid" style={{ marginBottom: 18 }}>
          <Select label="Class" value={cls} onChange={setCls}><option value="all">All classes</option>{d.classes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
          <Input label="Search" value={search} onChange={setSearch} placeholder="Name, admission number or parent phone" />
        </div>
        {rows.length ? <div className="simple-list">{rows.map((s) => <div className="simple-list-row" key={s.id}><div><strong>{s.full_name}</strong><span>{d.classes.find((x) => x.id === s.class_id)?.name} · {s.admission_no}{s.guardian_phone ? ` · ${s.guardian_phone}` : ""}</span></div><button className="button ghost" onClick={() => edit(s)}>Edit</button></div>)}</div> : <p className="muted">No matching students.</p>}
      </section>
    </div>
  );
}

function Reports({ d }: { d: Data }) {
  const p = current(d);
  const [sessionId, setSessionId] = useState(p.session?.id || "");
  const [termId, setTermId] = useState(p.term?.id || "");
  const [cat, setCat] = useState("");
  const [preset, setPreset] = useState<"period" | "today" | "month" | "custom">("period");
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const range = preset === "today" ? { from: todayISO(), to: todayISO() } : preset === "month" ? { from: monthStart, to: todayISO() } : preset === "custom" ? { from, to } : { from: undefined, to: undefined };
  const rows = d.categories.filter((x) => x.active && (!cat || x.id === cat)).map((c) => ({ c, s: catSummary(d, c, sessionId, termId, range.from, range.to) }));
  const total = rows.reduce((a, r) => a + r.s.collected, 0);
  const spent = rows.reduce((a, r) => a + r.s.spent, 0);

  function exportCsv() {
    const lines = ["Category,Internal,External,Collected,Expenses,Net Balance", ...rows.map(({ c, s }) => [categoryName(c), s.internalCount, isMixed(c) ? s.externalCount : 0, s.collected.toFixed(2), s.spent.toFixed(2), (s.collected - s.spent).toFixed(2)].map((v) => `\"${String(v).replaceAll('"', '""')}\"`).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ilawo-financial-report-${todayISO()}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="content-wrap">
      <Header title="Reports" description="Review collections, expenses and net balance by period and category." action={<div className="quick-actions"><button className="button ghost" onClick={exportCsv}>Download CSV</button><button className="button ghost" onClick={() => window.print()}>Print</button></div>} />
      <section className="panel filters-panel">
        <div className="form-grid">
          <Select label="Session" value={sessionId} onChange={(v) => { setSessionId(v); setTermId(d.terms.find((t) => t.session_id === v)?.id || ""); }}>{d.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          <Select label="Term" value={termId} onChange={setTermId}><option value="">Not term-specific</option>{d.terms.filter((t) => t.session_id === sessionId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          <Select label="Category" value={cat} onChange={setCat}><option value="">All categories</option>{d.categories.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{categoryName(x)}</option>)}</Select>
          <Select label="Date range" value={preset} onChange={(v) => setPreset(v as any)}><option value="period">Whole period</option><option value="today">Today</option><option value="month">This month</option><option value="custom">Custom dates</option></Select>
        </div>
        {preset === "custom" && <div className="form-grid" style={{ marginTop: 14 }}><Input label="From" type="date" value={from} onChange={setFrom} /><Input label="To" type="date" value={to} onChange={setTo} /></div>}
      </section>
      <div className="metric-grid"><Metric label="Collected" value={naira(total)} /><Metric label="Expenses" value={naira(spent)} tone="rose" /><Metric label="Net balance" value={naira(total - spent)} tone="ink" /></div>
      <section className="panel">
        <div className="table-scroll"><table><thead><tr><th>Category</th><th>Candidates / Students</th><th>Payment status</th><th>Collected</th><th>Expenses</th><th>Net balance</th></tr></thead><tbody>{rows.map(({ c, s }) => <tr key={c.id}><td><strong>{categoryName(c)}</strong></td><td>{isMixed(c) ? `${s.internalCount} internal · ${s.externalCount} external` : `${s.internalCount} internal`}</td><td>{s.fully} full · {s.part} part · {s.unpaid} unpaid</td><td>{naira(s.collected)}</td><td>{naira(s.spent)}</td><td><strong>{naira(s.collected - s.spent)}</strong></td></tr>)}</tbody></table></div>
      </section>
      {cat && rows[0]?.s.statusRows.length > 0 && (
        <section className="panel">
          <div className="panel-heading"><div><span className="section-kicker">PAYMENT STATUS NAMES</span><h2>{categoryName(rows[0].c)}</h2></div></div>
          <div className="simple-list">{rows[0].s.statusRows.map((row: R) => <div className="simple-list-row" key={row.id}><div><strong>{row.name}</strong><span>{row.type}{row.admission_no ? ` · ${row.admission_no}` : ""} · {naira(row.paid)} / {naira(row.due)}</span></div><Badge tone={row.status === "full" ? "success" : row.status === "part" ? "warning" : "danger"}>{row.status === "full" ? "Fully paid" : row.status === "part" ? "Partly paid" : "Not paid"}</Badge></div>)}</div>
        </section>
      )}
    </div>
  );
}

function Settings({ d, c, reload, notify }: { d: Data; c: AnyClient; reload: () => Promise<void>; notify: (x: NonNullable<Toast>) => void }) {
  const p = current(d);
  const [session, setSession] = useState(p.session?.id || "");
  const [term, setTerm] = useState(p.term?.id || "");
  const [name, setName] = useState("");
  const [b, setB] = useState("term");
  const [classIds, setClassIds] = useState<string[]>([]);
  const [chargeCat, setChargeCat] = useState("");
  const [chargeClass, setChargeClass] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [examCat, setExamCat] = useState("");
  const [examClass, setExamClass] = useState("");
  const [busy, setBusy] = useState(false);

  const examEligibleClassIds = new Set(d.categoryClasses.filter((x) => x.category_id === examCat).map((x) => x.class_id));
  const examStudents = d.students.filter(
    (s) => s.academic_session_id === session && (!examCat || examEligibleClassIds.has(s.class_id)) && (!examClass || s.class_id === examClass),
  );
  const registeredIds = new Set(d.candidates.filter((x) => x.category_id === examCat && x.session_id === session).map((x) => x.student_id));

  async function savePeriod() {
    setBusy(true);
    const { error } = await c.from("portal_settings").upsert({ id: 1, current_session_id: session, current_term_id: term || null, updated_by: d.profile.id });
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: "Current session and term saved." });
    await reload();
  }

  async function addCat(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { data: created, error } = await c.from("financial_categories").insert({ name: name.trim(), basis: b, applicable_to_term: b === "term", candidate_scope: "internal_only", active: true }).select("id").single();
    if (!error && created && classIds.length) {
      const r = await c.from("financial_category_classes").insert(classIds.map((class_id) => ({ category_id: created.id, class_id })));
      if (r.error) { setBusy(false); return notify({ type: "error", message: r.error.message }); }
    }
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    setName(""); setClassIds([]);
    notify({ type: "success", message: "Category added." });
    await reload();
  }

  async function saveCharge(e: FormEvent) {
    e.preventDefault();
    const category = d.categories.find((x) => x.id === chargeCat);
    if (!category) return;
    const selectedTerm = basis(category) === "term" ? term : null;
    const existing = d.charges.find((x) => x.category_id === chargeCat && x.class_id === chargeClass && x.session_id === session && (x.term_id || null) === (selectedTerm || null));
    const q = existing ? c.from("expected_charges").update({ expected_amount: numberValue(chargeAmount), active: true }).eq("id", existing.id) : c.from("expected_charges").insert({ category_id: chargeCat, class_id: chargeClass, session_id: session, term_id: selectedTerm, expected_amount: numberValue(chargeAmount), active: true });
    const { error } = await q;
    if (error) return notify({ type: "error", message: error.message });
    notify({ type: "success", message: "Expected amount saved." });
    await reload();
  }

  async function toggleCandidate(s: R) {
    if (!examCat) return;
    setBusy(true);
    const existing = d.candidates.find((x) => x.category_id === examCat && x.student_id === s.id && x.session_id === session);
    const q = existing ? c.from("category_candidates").delete().eq("id", existing.id) : c.from("category_candidates").insert({ category_id: examCat, student_id: s.id, session_id: session });
    const { error } = await q;
    setBusy(false);
    if (error) return notify({ type: "error", message: error.message });
    await reload();
  }

  return (
    <div className="content-wrap">
      <Header title="Settings" description="Set the school period, fees and examination registrations once. Recording then uses them automatically." />
      <div className="two-column">
        <section className="panel form-panel">
          <div className="panel-heading"><h2>Current session & term</h2></div>
          <div className="stack-form">
            <Select label="Session" value={session} onChange={(v) => { setSession(v); setTerm(d.terms.find((t) => t.session_id === v)?.id || ""); }}>{d.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
            <Select label="Term" value={term} onChange={setTerm}><option value="">No current term</option>{d.terms.filter((t) => t.session_id === session).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
            <button className="button primary full" disabled={busy} onClick={() => void savePeriod()}>Save current period</button>
          </div>
        </section>
        <section className="panel form-panel">
          <div className="panel-heading"><h2>Add financial category</h2></div>
          <form className="stack-form" onSubmit={addCat}>
            <Input label="Category name" value={name} onChange={setName} required placeholder="e.g. PTA Levy" />
            <Select label="Collection basis" value={b} onChange={setB}><option value="term">Every term</option><option value="session">Once per session</option><option value="one_off">One-off / special</option></Select>
            <p className="helper-line">New categories are internal-school categories. Only WAEC and NECO support external candidates.</p>
            <div className="check-grid">{d.classes.map((x) => <label key={x.id}><input type="checkbox" checked={classIds.includes(x.id)} onChange={(e) => setClassIds(e.target.checked ? [...classIds, x.id] : classIds.filter((id) => id !== x.id))} />{x.name}</label>)}</div>
            <button className="button secondary full" disabled={!classIds.length || busy}>Add category</button>
          </form>
        </section>
      </div>

      <section className="panel form-panel">
        <div className="panel-heading"><div><span className="section-kicker">EXPECTED PAYMENT</span><h2>Set amount per student</h2></div></div>
        <form className="stack-form" onSubmit={saveCharge}>
          <div className="form-grid"><Select label="Category" value={chargeCat} onChange={setChargeCat}><option value="">Choose category</option>{d.categories.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{categoryName(x)}</option>)}</Select><Select label="Class" value={chargeClass} onChange={setChargeClass}><option value="">Choose class</option>{d.classes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></div>
          <Input label="Expected amount (₦)" type="number" value={chargeAmount} onChange={setChargeAmount} />
          <button className="button primary" disabled={!chargeCat || !chargeClass}>Save expected amount</button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="section-kicker">WAEC / NECO INTERNAL REGISTRATION</span><h2>Select internal candidates</h2></div></div>
        <p className="helper-line">WAEC and NECO can contain both Ilawo students and external candidates. Select only the Ilawo students actually registered for the exam.</p>
        <div className="form-grid" style={{ marginTop: 14 }}>
          <Select label="Exam" value={examCat} onChange={setExamCat}><option value="">Choose WAEC or NECO</option>{d.categories.filter((x) => x.active && isMixed(x)).map((x) => <option key={x.id} value={x.id}>{categoryName(x)}</option>)}</Select>
          <Select label="Class" value={examClass} onChange={setExamClass}><option value="">All eligible classes</option>{d.classes.filter((x) => ["SS2", "SS3"].includes(x.name)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        </div>
        {examCat ? <div className="check-grid" style={{ marginTop: 16 }}>{examStudents.map((s) => <label key={s.id}><input type="checkbox" checked={registeredIds.has(s.id)} disabled={busy} onChange={() => void toggleCandidate(s)} />{s.full_name}</label>)}</div> : <p className="muted">Choose WAEC or NECO to manage internal candidates.</p>}
      </section>

      <section className="panel">
        <div className="panel-heading"><h2>Configured categories</h2></div>
        <div className="simple-list">{d.categories.filter((x) => x.active).map((x) => <div className="simple-list-row" key={x.id}><div><strong>{categoryName(x)}</strong><span>{basis(x) === "term" ? "Term-based" : basis(x) === "session" ? "Session-based" : "One-off / special"} · {isMixed(x) ? "Internal + external" : "Internal only"}</span></div><Badge tone="success">Active</Badge></div>)}</div>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="section-kicker">PERSONAL BUSINESS</span><h2>Private small-trade record</h2></div><Badge tone="neutral">Separate</Badge></div>
        <p className="helper-line">Products, stock, sales and private business expenses stay completely separate from school collections.</p>
        <a className="button ghost" href="/personal-business">Open Personal Business →</a>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><span className="section-kicker">CHATGPT COMMAND CENTER</span><h2>Agent-ready portal</h2></div><Badge tone="info">Backend prepared</Badge></div>
        <p className="helper-line">The portal exposes a secure command-center API/MCP layer so the Principal can query finances and perform approved actions from ChatGPT. Connection availability depends on the ChatGPT plan; the portal itself remains the source of truth and all writes still pass through Supabase RLS and audit rules.</p>
      </section>
    </div>
  );
}

async function load(c: AnyClient, u: User): Promise<Data> {
  const { data: profile, error } = await c.from("profiles").select("*").eq("id", u.id).single();
  if (error) throw error;
  if (!profile?.active) throw new Error("This account is inactive.");
  if (profile.role !== "principal") throw new Error("This portal is reserved for the Principal account.");

  const [classes, sessions, terms, categories, categoryClasses, students, charges, payments, expenses, candidates, external, externalPayments, settings] = await Promise.all([
    opt(c, "classes"), opt(c, "academic_sessions"), opt(c, "terms"), opt(c, "financial_categories"), opt(c, "financial_category_classes"), opt(c, "students"), opt(c, "expected_charges"), opt(c, "effective_payment_ledger"), opt(c, "school_expenses"), opt(c, "category_candidates"), opt(c, "external_candidates"), opt(c, "external_candidate_payments"), opt(c, "portal_settings"),
  ]);
  const real = sessions.filter((s: R) => !s.is_test);
  const ids = new Set(real.map((s: R) => s.id));
  return {
    profile,
    classes: classes.filter((x: R) => x.active).sort((a: R, b: R) => a.display_order - b.display_order),
    sessions: real,
    terms,
    categories: categories.sort((a: R, b: R) => categoryName(a).localeCompare(categoryName(b))),
    categoryClasses,
    students: students.filter((x: R) => ids.has(x.academic_session_id)),
    charges: charges.filter((x: R) => ids.has(x.session_id)),
    payments: payments.filter((x: R) => ids.has(x.session_id) && !x.is_test),
    expenses: expenses.filter((x: R) => ids.has(x.session_id) && !x.is_test),
    candidates: candidates.filter((x: R) => ids.has(x.session_id)),
    external: external.filter((x: R) => ids.has(x.session_id)),
    externalPayments: externalPayments.filter((x: R) => ids.has(x.session_id) && !x.is_test),
    settings: settings[0] || null,
  };
}

export default function PrincipalPortalV4() {
  const [c, setC] = useState<AnyClient | null>(null);
  const [u, setU] = useState<User | null>(null);
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("home");
  const [toast, setToast] = useState<Toast>(null);

  const refresh = useCallback(async (client: AnyClient, user: User) => {
    setError("");
    try { setD(await load(client, user)); } catch (e) { setError(message(e)); setD(null); } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const client = getSupabaseBrowserClient() as AnyClient | null;
    setC(client);
    if (!client) { setLoading(false); return; }
    let mounted = true;
    client.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const user = data.session?.user || null;
      setU(user);
      if (user) void refresh(client, user); else setLoading(false);
    });
    const { data: l } = client.auth.onAuthStateChange((_e, s) => {
      if (!mounted) return;
      const user = s?.user || null;
      setU(user);
      if (user) void refresh(client, user); else { setD(null); setLoading(false); }
    });
    return () => { mounted = false; l.subscription.unsubscribe(); };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!c || !u) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let lastRefreshAt = Date.now();

    const requestRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        lastRefreshAt = Date.now();
        void refresh(c, u);
      }, 650);
    };

    const channel = c
      .channel("ilawo-principal-live-record-book")
      .on("postgres_changes", { event: "*", schema: "public" }, requestRefresh)
      .subscribe();

    const refreshAfterBackground = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshAt >= 15_000) requestRefresh();
    };

    window.addEventListener("focus", refreshAfterBackground);
    document.addEventListener("visibilitychange", refreshAfterBackground);

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      window.removeEventListener("focus", refreshAfterBackground);
      document.removeEventListener("visibilitychange", refreshAfterBackground);
      void c.removeChannel(channel);
    };
  }, [c, u, refresh]);

  if (!u || !c) return <Login c={c} />;
  if (loading) return <main className="loading-page"><Brand small /><div className="loading-spinner" /><p>Opening your financial record book…</p></main>;
  if (error || !d) return <main className="loading-page"><Brand small /><div className="setup-alert"><strong>Portal could not be loaded</strong><p>{error}</p></div><button className="button ghost" onClick={() => void c.auth.signOut()}>Sign out</button></main>;

  const reload = () => refresh(c, u);
  const go = (x: Tab) => { setTab(x); window.scrollTo({ top: 0, behavior: "smooth" }); };

  return (
    <div className="portal-layout">
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-rule" />
        <p className="nav-caption">PRINCIPAL RECORD BOOK</p>
        <nav className="side-nav">{nav.map(([id, label, icon]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => go(id)}><span className="nav-icon">{icon}</span>{label}</button>)}</nav>
        <div className="sidebar-bottom"><button className="logout-button" onClick={() => void c.auth.signOut()}>Sign out</button></div>
      </aside>
      <main className="main-content">
        <header className="mobile-topbar"><Brand small /><button className="logout-button" onClick={() => void c.auth.signOut()}>Sign out</button></header>
        {toast && <div className={`toast ${toast.type}`}>{toast.message}<button onClick={() => setToast(null)}>×</button></div>}
        {tab === "home" && <Home d={d} go={go} />}
        {tab === "record" && <Record d={d} c={c} reload={reload} notify={setToast} />}
        {tab === "classes" && <Classes d={d} c={c} reload={reload} notify={setToast} />}
        {tab === "reports" && <Reports d={d} />}
        {tab === "settings" && <Settings d={d} c={c} reload={reload} notify={setToast} />}
      </main>
      <nav className="mobile-nav">{nav.map(([id, label, icon]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => go(id)}><span>{icon}</span>{label}</button>)}</nav>
    </div>
  );
}
