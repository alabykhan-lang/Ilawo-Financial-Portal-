import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicSupabaseConfig } from "@/lib/public-supabase-config";

let browserClient: SupabaseClient | null = null;

export function isSupabaseConfigured() {
  const { url, key } = getPublicSupabaseConfig();
  return Boolean(url && key);
}

export function getSupabaseBrowserClient() {
  if (browserClient) return browserClient;
  const { url, key } = getPublicSupabaseConfig();
  if (!url || !key) return null;
  browserClient = createBrowserClient(url, key);
  return browserClient;
}
