"use client";

import { useEffect, useRef, useState } from "react";
import PrincipalPortalV4 from "@/components/PrincipalPortalV4";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

/**
 * Keeps the Principal portal aligned with writes made outside the open page
 * (for example from the Principal's connected ChatGPT/Supabase session).
 *
 * One schema-level Realtime subscription is deliberately used instead of a
 * separate filter for every table. That makes the client tolerant while a
 * new migration is being rolled out: tables that are not yet present cannot
 * break the subscription, and newly published financial tables begin working
 * without another frontend release.
 *
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

    const channel = client
      .channel("ilawo-principal-live-record-book")
      .on(
        "postgres_changes",
        { event: "*", schema: "public" },
        requestRefresh,
      )
      .subscribe();

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
