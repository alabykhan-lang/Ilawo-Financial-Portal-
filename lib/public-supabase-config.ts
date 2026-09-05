export const ILAWO_SUPABASE_URL = "https://swqvzqncjszzifzrjmcc.supabase.co";
export const ILAWO_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN3cXZ6cW5janN6emlmenJqbWNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNDk1MDEsImV4cCI6MjEwMzgyNTUwMX0.jBJj08xpnAL9ga_vFzAizcen4dDlL4ho99-MB3x94Is";

export function getPublicSupabaseConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || ILAWO_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ILAWO_SUPABASE_ANON_KEY,
  };
}
