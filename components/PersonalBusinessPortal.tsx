"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { naira, numberValue, shortDate, todayISO } from "@/lib/format";

type AnyClient = SupabaseClient<any>;
type R = Record<string, any>;
type Toast = { type: "success" | "error" | "info"; message: string } | null;

type BusinessData = {
  profile: R;
  products: R[];
  sales: R[];
  expenses: R[];
};

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as any).message)
      : "Something went wrong.";
}

async function loadBusiness(client: AnyClient, user: User): Promise<BusinessData> {
  const [{ data: profile, error: profileError }, products, sales, expenses] = await Promise.all([
    client.from("profiles").select("id,full_name,role,active").eq("id", user.id).single(),
    client.from("personal_products").select("*").order("name"),
    client.from("personal_sales").select("*").order("sold_at", { ascending: false }),
    client.from("personal_expenses").select("*").order("expense_date", { ascending: false }),
  ]);

  if (profileError) throw profileError;
  if (!profile?.active || profile.role !== "principal") {
    throw new Error("Personal Business is reserved for the Principal account.");
  }
  if (products.error) throw products.error;
  if (sales.error) throw sales.error;
  if (expenses.error) throw expenses.error;

  return {
    profile,
    products: products.data || [],
    sales: sales.data || [],
    expenses: expenses.data || [],
  };
}

export default function PersonalBusinessPortal() {
  const [client, setClient] = useState<AnyClient | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [data, setData] = useState<BusinessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast>(null);

  const [productName, setProductName] = useState("");
  const [cost, setCost] = useState("");
  const [selling, setSelling] = useState("");
  const [quantity, setQuantity] = useState("");
  const [saleProduct, setSaleProduct] = useState("");
  const [saleQuantity, setSaleQuantity] = useState("1");
  const [salePrice, setSalePrice] = useState("");
  const [saleNote, setSaleNote] = useState("");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState(todayISO());
  const [expenseNote, setExpenseNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (c: AnyClient, u: User) => {
    setError("");
    try {
      setData(await loadBusiness(c, u));
    } catch (e) {
      setError(errorMessage(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const c = getSupabaseBrowserClient() as AnyClient | null;
    setClient(c);
    if (!c) {
      setError("Supabase is not configured.");
      setLoading(false);
      return;
    }

    let mounted = true;
    c.auth.getSession().then(({ data: sessionData }) => {
      if (!mounted) return;
      const u = sessionData.session?.user || null;
      setUser(u);
      if (u) void refresh(c, u);
      else setLoading(false);
    });

    const { data: listener } = c.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const u = session?.user || null;
      setUser(u);
      if (u) void refresh(c, u);
      else {
        setData(null);
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!saleProduct || !data) return;
    const product = data.products.find((p) => p.id === saleProduct);
    if (product && !salePrice) setSalePrice(String(product.selling_price ?? ""));
  }, [saleProduct, salePrice, data]);

  const summary = useMemo(() => {
    const salesRevenue = (data?.sales || []).reduce(
      (total, sale) => total + numberValue(sale.unit_price) * numberValue(sale.quantity),
      0,
    );
    const grossProfit = (data?.sales || []).reduce(
      (total, sale) => total + (numberValue(sale.unit_price) - numberValue(sale.unit_cost)) * numberValue(sale.quantity),
      0,
    );
    const expenses = (data?.expenses || []).reduce((total, row) => total + numberValue(row.amount), 0);
    const stockCost = (data?.products || []).reduce(
      (total, product) => total + numberValue(product.cost_price) * numberValue(product.quantity),
      0,
    );
    return { salesRevenue, grossProfit, expenses, stockCost, netProfit: grossProfit - expenses };
  }, [data]);

  async function addProduct(event: FormEvent) {
    event.preventDefault();
    if (!client || !user) return;
    setBusy(true);
    const { error: writeError } = await client.from("personal_products").insert({
      name: productName.trim(),
      cost_price: numberValue(cost),
      selling_price: numberValue(selling),
      quantity: Math.floor(numberValue(quantity)),
      active: true,
    });
    setBusy(false);
    if (writeError) return setToast({ type: "error", message: writeError.message });
    setProductName(""); setCost(""); setSelling(""); setQuantity("");
    setToast({ type: "success", message: "Product added to Personal Business." });
    await refresh(client, user);
  }

  async function restock(product: R) {
    if (!client || !user) return;
    const raw = window.prompt(`Add how many units of ${product.name}?`, "1");
    if (raw === null) return;
    const extra = Math.floor(numberValue(raw));
    if (extra <= 0) return setToast({ type: "info", message: "Enter a quantity greater than zero." });
    setBusy(true);
    const { error: writeError } = await client
      .from("personal_products")
      .update({ quantity: numberValue(product.quantity) + extra })
      .eq("id", product.id);
    setBusy(false);
    if (writeError) return setToast({ type: "error", message: writeError.message });
    setToast({ type: "success", message: `${product.name} stock increased by ${extra}.` });
    await refresh(client, user);
  }

  async function recordSale(event: FormEvent) {
    event.preventDefault();
    if (!client || !user || !saleProduct) return;
    setBusy(true);
    const { error: writeError } = await client.rpc("record_personal_sale", {
      p_product_id: saleProduct,
      p_quantity: Math.floor(numberValue(saleQuantity)),
      p_unit_price: numberValue(salePrice),
      p_note: saleNote || null,
    });
    setBusy(false);
    if (writeError) return setToast({ type: "error", message: writeError.message });
    setSaleQuantity("1"); setSaleNote("");
    setToast({ type: "success", message: "Sale recorded and stock adjusted." });
    await refresh(client, user);
  }

  async function recordExpense(event: FormEvent) {
    event.preventDefault();
    if (!client || !user) return;
    setBusy(true);
    const { error: writeError } = await client.from("personal_expenses").insert({
      description: expenseDescription.trim(),
      amount: numberValue(expenseAmount),
      expense_date: expenseDate,
      note: expenseNote || null,
    });
    setBusy(false);
    if (writeError) return setToast({ type: "error", message: writeError.message });
    setExpenseDescription(""); setExpenseAmount(""); setExpenseNote("");
    setToast({ type: "success", message: "Personal Business expense recorded." });
    await refresh(client, user);
  }

  if (!user) {
    return (
      <main className="auth-page">
        <section className="auth-card">
          <span className="section-kicker">PERSONAL BUSINESS</span>
          <h1>Principal sign-in required.</h1>
          <p>This area is deliberately separate from school finances.</p>
          <Link className="button primary full" href="/">Go to Principal sign-in</Link>
        </section>
      </main>
    );
  }

  if (loading) return <main className="loading-page"><div className="loading-spinner" /><p>Opening Personal Business…</p></main>;
  if (error || !data) {
    return (
      <main className="loading-page">
        <div className="setup-alert"><strong>Personal Business could not be loaded</strong><p>{error}</p></div>
        <Link className="button ghost" href="/">Back to school record book</Link>
      </main>
    );
  }

  return (
    <div className="content-wrap" style={{ maxWidth: 1180, margin: "0 auto", paddingBottom: 48 }}>
      {toast && <div className={`toast ${toast.type}`}>{toast.message}<button onClick={() => setToast(null)}>×</button></div>}
      <div className="page-header">
        <div>
          <span className="section-kicker">PRINCIPAL · PRIVATE AREA</span>
          <h1>Personal Business</h1>
          <p>Small-trade stock, sales and expenses. These figures never mix with school money.</p>
        </div>
        <Link className="button ghost" href="/">← School record book</Link>
      </div>

      <div className="metric-grid">
        <div className="metric-card teal"><p>Sales revenue</p><strong>{naira(summary.salesRevenue)}</strong><span>All recorded sales</span></div>
        <div className="metric-card gold"><p>Stock at cost</p><strong>{naira(summary.stockCost)}</strong><span>Current unsold stock</span></div>
        <div className="metric-card rose"><p>Business expenses</p><strong>{naira(summary.expenses)}</strong><span>Separate from school expenses</span></div>
        <div className="metric-card ink"><p>Net profit</p><strong>{naira(summary.netProfit)}</strong><span>Gross margin less business expenses</span></div>
      </div>

      <div className="two-column">
        <section className="panel form-panel">
          <div className="panel-heading"><div><span className="section-kicker">INVENTORY</span><h2>Add product / opening stock</h2></div></div>
          <form className="stack-form" onSubmit={addProduct}>
            <label className="field-label">Product name<input required value={productName} onChange={(e) => setProductName(e.target.value)} /></label>
            <div className="form-grid">
              <label className="field-label">Cost price (₦)<input required type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} /></label>
              <label className="field-label">Selling price (₦)<input required type="number" min="0" step="0.01" value={selling} onChange={(e) => setSelling(e.target.value)} /></label>
            </div>
            <label className="field-label">Opening quantity<input required type="number" min="0" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
            <button className="button secondary full" disabled={busy}>Add product</button>
          </form>
        </section>

        <section className="panel form-panel">
          <div className="panel-heading"><div><span className="section-kicker">SALE</span><h2>Record sale</h2></div></div>
          <form className="stack-form" onSubmit={recordSale}>
            <label className="field-label">Product<select required value={saleProduct} onChange={(e) => { setSaleProduct(e.target.value); setSalePrice(""); }}><option value="">Choose product</option>{data.products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.quantity} in stock</option>)}</select></label>
            <div className="form-grid">
              <label className="field-label">Quantity<input required type="number" min="1" step="1" value={saleQuantity} onChange={(e) => setSaleQuantity(e.target.value)} /></label>
              <label className="field-label">Unit selling price (₦)<input required type="number" min="0" step="0.01" value={salePrice} onChange={(e) => setSalePrice(e.target.value)} /></label>
            </div>
            <label className="field-label">Note (optional)<input value={saleNote} onChange={(e) => setSaleNote(e.target.value)} /></label>
            <button className="button primary full" disabled={busy || !saleProduct}>Save sale</button>
          </form>
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-heading"><div><span className="section-kicker">CURRENT STOCK</span><h2>{data.products.filter((p) => p.active).length} products</h2></div></div>
          <div className="simple-list">
            {data.products.filter((p) => p.active).map((p) => (
              <div className="simple-list-row" key={p.id}>
                <div><strong>{p.name}</strong><span>{p.quantity} units · cost {naira(p.cost_price)} · sell {naira(p.selling_price)}</span></div>
                <button className="button ghost" disabled={busy} onClick={() => void restock(p)}>Restock</button>
              </div>
            ))}
            {!data.products.length && <p className="muted">No personal products recorded yet.</p>}
          </div>
        </section>

        <section className="panel form-panel">
          <div className="panel-heading"><div><span className="section-kicker">EXPENSE</span><h2>Record business expense</h2></div></div>
          <form className="stack-form" onSubmit={recordExpense}>
            <label className="field-label">Description<input required value={expenseDescription} onChange={(e) => setExpenseDescription(e.target.value)} /></label>
            <div className="form-grid">
              <label className="field-label">Amount (₦)<input required type="number" min="0.01" step="0.01" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} /></label>
              <label className="field-label">Date<input required type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} /></label>
            </div>
            <label className="field-label">Note (optional)<input value={expenseNote} onChange={(e) => setExpenseNote(e.target.value)} /></label>
            <button className="button primary full" disabled={busy}>Save business expense</button>
          </form>
        </section>
      </div>

      <div className="two-column">
        <section className="panel">
          <div className="panel-heading"><h2>Recent sales</h2></div>
          {data.sales.slice(0, 12).map((sale) => {
            const product = data.products.find((p) => p.id === sale.product_id);
            return <div className="simple-list-row" key={sale.id}><div><strong>{product?.name || "Product"}</strong><span>{sale.quantity} × {naira(sale.unit_price)} · {shortDate(String(sale.sold_at).slice(0, 10))}</span></div><b>{naira(numberValue(sale.quantity) * numberValue(sale.unit_price))}</b></div>;
          })}
          {!data.sales.length && <p className="muted">No sales recorded yet.</p>}
        </section>
        <section className="panel">
          <div className="panel-heading"><h2>Recent expenses</h2></div>
          {data.expenses.slice(0, 12).map((row) => <div className="simple-list-row" key={row.id}><div><strong>{row.description}</strong><span>{shortDate(row.expense_date)}</span></div><b>{naira(row.amount)}</b></div>)}
          {!data.expenses.length && <p className="muted">No business expenses recorded yet.</p>}
        </section>
      </div>
    </div>
  );
}
