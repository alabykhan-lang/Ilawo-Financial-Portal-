"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function SetupPage() {
  const router = useRouter();
  const [form, setForm] = useState({ fullName: "", email: "", password: "", secret: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setMessage(result.error || "Setup could not be completed.");
      return;
    }
    router.push("/?setup=complete");
  }

  return (
    <main className="setup-page">
      <section className="setup-card">
        <div className="brand-lockup compact">
          <Image src="/ilawo-mark.svg" alt="Ilawo Community Grammar School mark" width={48} height={48} priority />
          <div>
            <p className="eyebrow">Office of the Principal</p>
            <h1>Ilawo Financial Portal</h1>
            <p className="muted">Knowledge Is Light</p>
          </div>
        </div>
        <div className="section-heading">
          <span className="section-kicker">ONE-TIME SETUP</span>
          <h2>Create the first Principal account</h2>
          <p>This form works only while no Principal exists and requires the server-only bootstrap secret.</p>
        </div>
        <form className="stack-form" onSubmit={submit}>
          <label>Principal name<input required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="e.g. A. O. Principal" /></label>
          <label>Login email<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="principal@example.com" /></label>
          <label>Temporary password<input required minLength={8} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="At least 8 characters" /></label>
          <label>Bootstrap secret<input required type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="From server environment settings" /></label>
          {message && <p className="form-error">{message}</p>}
          <button className="button primary full" disabled={busy}>{busy ? "Creating account…" : "Create Principal account"}</button>
        </form>
        <button className="text-button" onClick={() => router.push("/")}>Back to login</button>
      </section>
    </main>
  );
}
