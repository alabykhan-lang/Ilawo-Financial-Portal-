"use client";

import { useEffect, useRef, useState } from "react";
import PrincipalPortalV4 from "@/components/PrincipalPortalV4";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

const LIVE_TABLES = [
  "portal_settings",
  "students",
  "academic_sessions",
  "terms",
  "classes",
  "financial_categories",
  "financial_category_classes",
  "expected_charges",
  "student_payments",
  "payment_corrections",
  "category_candidates",
  "external_candidates",
  "external_candidate_payments",
  "school_expenses",
  "personal_business",
  "personal_business_income",
  "personal_business_expenses",
] as const;

/**
 * Keeps the Principal portal aligned with writes made outside the open page
 * (for example from the Principal's connected ChatGPT/Supabase session).
 *
 * Realtime events remount the record-book client so its complete financial
 * snapshot is re-read through the Principal's existing authenticated session.
 * A focus/visibility fallback covers browsers that temporarily suspend
 * realtime connections while the phone is in the background.
 */
export default function PrincipalPortalLive() {
  const [revision, setRevision] = useState(0);
  const lastRefreshAt = useRef(Date.now());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const client = getSupabaseBrowserClient();
    if (!client) return;

    const requestRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        lastRefreshAt.current = Date.now();
        setRevision((value) => value + 1);
      }, 650);
    };

    let channel = client.channel("ilawo-principal-live-record-book");
    for (const table of LIVE_TABLES) {
      channel = channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        requestRefresh,
      );
    }
    channel.subscribe();

    const refreshAfterBackground = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshAt.current >= 15_000) requestRefresh();
    };

    window.addEventListener("focus", refreshAfterBackground);
    document.addEventListener("visibilitychange", refreshAfterBackground);

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      window.removeEventListener("focus", refreshAfterBackground);
      document.removeEventListener("visibilitychange", refreshAfterBackground);
      void client.removeChannel(channel);
    };
  }, []);

  return <PrincipalPortalV4 key={revision} />;
}
