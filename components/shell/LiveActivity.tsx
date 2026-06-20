"use client";

import { useEffect, useRef, useState } from "react";

type Conn = "connecting" | "live" | "offline";

const DOT: Record<Conn, string> = {
  connecting: "var(--warning, #fbbf24)",
  live: "var(--positive, #6ee7b7)",
  offline: "var(--negative, #f87171)",
};
const LABEL: Record<Conn, string> = {
  connecting: "Connecting",
  live: "Live",
  offline: "Offline",
};

// Global server heartbeat. Lives in a fixed corner on every surface (mobile +
// desktop) so you always know the app is talking to its server: a pulsing dot
// while a request is in flight, steady green when the last poll succeeded, red
// when it failed. Self-contained — pings /api/status on an interval, no store.
export function LiveActivity({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const [conn, setConn] = useState<Conn>("connecting");
  const [inFlight, setInFlight] = useState(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;

    const ping = async () => {
      if (!mounted.current) return;
      setInFlight(true);
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), Math.max(4000, intervalMs - 1000));
      try {
        const res = await fetch("/api/status", { cache: "no-store", signal: ctrl.signal });
        if (!mounted.current) return;
        setConn(res.ok ? "live" : "offline");
      } catch {
        if (mounted.current) setConn("offline");
      } finally {
        clearTimeout(to);
        if (mounted.current) {
          setInFlight(false);
          timer = setTimeout(ping, intervalMs);
        }
      }
    };

    ping();
    return () => {
      mounted.current = false;
      clearTimeout(timer);
    };
  }, [intervalMs]);

  return (
    <div
      aria-live="polite"
      title={`Server ${LABEL[conn].toLowerCase()}`}
      className="pointer-events-none fixed z-[60] flex items-center gap-1.5 rounded-full px-2 py-1 font-mono-ui text-[0.6rem] tracking-wide text-text-tertiary"
      style={{
        top: "calc(env(safe-area-inset-top) + 6px)",
        right: "calc(env(safe-area-inset-right) + 8px)",
        background: "color-mix(in srgb, var(--background-base) 70%, transparent)",
        backdropFilter: "blur(10px) saturate(140%)",
        WebkitBackdropFilter: "blur(10px) saturate(140%)",
      }}
    >
      <span className="relative inline-flex h-2 w-2 shrink-0">
        {inFlight && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
            style={{ background: DOT[conn] }}
          />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: DOT[conn] }}
        />
      </span>
      <span>{LABEL[conn]}</span>
    </div>
  );
}
