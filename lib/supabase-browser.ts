import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

// These are public browser credentials for the Ilawo project. Privileged
// service-role/database credentials remain server-only and are never bundled.
const ILAWO_SUPABASE_URL = "https://swqvzqncjszzifzrjmcc.supabase.co";
const ILAWO_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN3cXZ6cW5janN6emlmenJqbWNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNDk1MDEsImV4cCI6MjEwMzgyNTUwMX0.jBJj08xpnAL9ga_vFzAizcen4dDlL4ho99-MB3x94Is";

function publicConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || ILAWO_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ILAWO_SUPABASE_ANON_KEY,
  };
}

export function isSupabaseConfigured() {
  const { url, key } = publicConfig();
  return Boolean(url && key);
}

export function getSupabaseBrowserClient() {
  if (browserClient) return browserClient;
  const { url, key } = publicConfig();
  if (!url || !key) return null;
  browserClient = createBrowserClient(url, key);
  return browserClient;
}
