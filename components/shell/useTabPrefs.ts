"use client";

import { useCallback, useEffect, useState } from "react";
import { PRIMARY_TAB_IDS, ALL_TABS, type TabId } from "./tabs";

/**
 * Persisted bottom-bar pin preferences. The user long-presses a tab to pin or
 * unpin it from the primary row; the ordered list of pinned ids lives in
 * localStorage so the bar restores between launches.
 *
 * Defaults to the built-in PRIMARY_TAB_IDS so behavior is unchanged on first
 * load. SSR-safe (every window/localStorage access is guarded). The bar caps at
 * MAX_PINNED so the 6th slot is always "More"; pinning past the cap drops the
 * oldest pin (FIFO) so the action is always predictable.
 */

const STORAGE_KEY = "lo-tab-prefs-v3";
/** Bottom bar shows at most this many pinned tabs; the next slot is "More". */
export const MAX_PINNED = 6;

/** Tabs that are always pinned and cannot be unpinned, reordered, or evicted.
 *  These anchor the bar so the core surfaces never move. */
export const LOCKED_TAB_IDS: TabId[] = [
  "tasks",
  "sessions",
  "repos",
  "kanban",
  "cron",
  "config",
];

const VALID_IDS = new Set<TabId>(ALL_TABS.map((t) => t.id));

function sanitize(ids: TabId[]): TabId[] {
  const seen = new Set<TabId>();
  const valid: TabId[] = [];
  for (const id of ids) {
    if (VALID_IDS.has(id) && !seen.has(id)) {
      seen.add(id);
      valid.push(id);
    }
  }
  // Locked tabs always lead, in their canonical order, and are guaranteed
  // present even if a stale stored list omitted them. The remaining slots go to
  // the user's other pinned tabs (in their stored order).
  const locked = LOCKED_TAB_IDS.filter((id) => VALID_IDS.has(id));
  const rest = valid.filter((id) => !LOCKED_TAB_IDS.includes(id));
  const room = Math.max(0, MAX_PINNED - locked.length);
  return [...locked, ...rest.slice(0, room)];
}

function readStored(): TabId[] {
  if (typeof window === "undefined") return sanitize([...PRIMARY_TAB_IDS]);
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return sanitize([...PRIMARY_TAB_IDS]);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return sanitize([...PRIMARY_TAB_IDS]);
    const clean = sanitize(parsed as TabId[]);
    return clean.length ? clean : sanitize([...PRIMARY_TAB_IDS]);
  } catch {
    return sanitize([...PRIMARY_TAB_IDS]);
  }
}

function writeStored(ids: TabId[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* private mode / quota; ignore */
  }
}

export interface TabPrefs {
  pinnedIds: TabId[];
  pin: (id: TabId) => void;
  unpin: (id: TabId) => void;
  isPinned: (id: TabId) => boolean;
  isLocked: (id: TabId) => boolean;
  /** Move a pinned tab from one index to another (drag-reorder). Locked tabs
   *  refuse to move and nothing can be dropped before them. */
  reorder: (fromIndex: number, toIndex: number) => void;
}

export function useTabPrefs(): TabPrefs {
  // Start from the sanitized default split on both server and first client
  // render to keep hydration stable, then hydrate the stored list after mount.
  const [pinnedIds, setPinnedIds] = useState<TabId[]>(() =>
    sanitize([...PRIMARY_TAB_IDS]),
  );

  useEffect(() => {
    setPinnedIds(readStored());
  }, []);

  const pin = useCallback((id: TabId) => {
    setPinnedIds((prev) => {
      if (!VALID_IDS.has(id) || prev.includes(id)) return prev;
      let next = [...prev, id];
      // Over the cap: evict the oldest NON-locked pin (locked tabs are anchored
      // and can never be dropped). FIFO over the unlocked subset.
      if (next.length > MAX_PINNED) {
        const victim = next.find((p) => !LOCKED_TAB_IDS.includes(p));
        if (victim) next = next.filter((p) => p !== victim);
        else next = next.slice(0, MAX_PINNED);
      }
      writeStored(next);
      return next;
    });
  }, []);

  const unpin = useCallback((id: TabId) => {
    if (LOCKED_TAB_IDS.includes(id)) return; // locked tabs can't be unpinned
    setPinnedIds((prev) => {
      if (!prev.includes(id)) return prev;
      const next = prev.filter((p) => p !== id);
      writeStored(next);
      return next;
    });
  }, []);

  const isPinned = useCallback(
    (id: TabId) => pinnedIds.includes(id),
    [pinnedIds],
  );

  const isLocked = useCallback((id: TabId) => LOCKED_TAB_IDS.includes(id), []);

  const reorder = useCallback((fromIndex: number, toIndex: number) => {
    setPinnedIds((prev) => {
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length ||
        fromIndex === toIndex
      ) {
        return prev;
      }
      // Locked tabs are anchored: they can't be moved, and nothing may land in
      // a slot occupied by a locked tab (which would shift it).
      if (LOCKED_TAB_IDS.includes(prev[fromIndex])) return prev;
      if (LOCKED_TAB_IDS.includes(prev[toIndex])) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      writeStored(next);
      return next;
    });
  }, []);

  return { pinnedIds, pin, unpin, isPinned, isLocked, reorder };
}
