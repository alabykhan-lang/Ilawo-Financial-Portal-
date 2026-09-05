"use client";

import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

export default function OAuthConsentPage() {
  const params = useSearchParams();
  const authorizationId = params.get("authorization_id") || "";
  const client = getSupabaseBrowserClient() as any;
  const [details, setDetails] = useState<any>(null);
  const [user, setUser] = useState<any>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!client || !authorizationId) return;
    const session = await client.auth.getSession();
    setUser(session.data.session?.user || null);
    const result = await client.auth.oauth.getAuthorizationDetails(authorizationId);
    if (result.error) setError(result.error.message || "Authorization request could not be loaded.");
    else setDetails(result.data);
  }

  useEffect(() => { void load(); }, [authorizationId]);

  async function signIn(e: FormEvent) {
    e.preventDefault();
    if (!client) return;
    setBusy(true); setError("");
    const result = await client.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (result.error) return setError(result.error.message);
    await load();
  }

  async function decide(approve: boolean) {
    if (!client || !authorizationId) return;
    setBusy(true); setError("");
    const result = approve
      ? await client.auth.oauth.approveAuthorization(authorizationId)
      : await client.auth.oauth.denyAuthorization(authorizationId);
    setBusy(false);
    if (result.error) return setError(result.error.message || "Authorization could not be completed.");
    if (result.data?.redirect_url) window.location.href = result.data.redirect_url;
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <span className="section-kicker">ILAWO FINANCIAL PORTAL</span>
        <div className="auth-heading">
          <h1>Connect ChatGPT</h1>
          <p>Allow the Principal's ChatGPT command center to read school finance data and perform approved actions using the same protected account permissions.</p>
        </div>
        {!authorizationId && <div className="setup-alert"><strong>Missing authorization request</strong><p>Start the connection from ChatGPT, then return here.</p></div>}
        {error && <p className="form-error">{error}</p>}
        {authorizationId && !user && (
          <form className="stack-form" onSubmit={signIn}>
            <label className="field-label">Principal email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="field-label">Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <button className="button primary full" disabled={busy}>{busy ? "Signing in…" : "Sign in to continue"}</button>
          </form>
        )}
        {authorizationId && user && details && (
          <div className="stack-form">
            <div className="panel" style={{ margin: 0 }}>
              <strong>{details.client?.name || details.client_name || "ChatGPT"}</strong>
              <p className="helper-line">Signed in as {user.email}</p>
              <p className="helper-line">Requested access: {details.scope || "profile and portal actions"}</p>
            </div>
            <p className="helper-line">Financial changes remain protected by the portal's database rules and audit trail. The command center cannot bypass payment immutability.</p>
            <button className="button primary full" disabled={busy} onClick={() => void decide(true)}>Allow connection</button>
            <button className="button ghost full" disabled={busy} onClick={() => void decide(false)}>Deny</button>
          </div>
        )}
      </section>
    </main>
  );
}
