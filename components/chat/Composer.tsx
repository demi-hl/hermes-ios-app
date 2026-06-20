"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SVGProps } from "react";
import { motion } from "framer-motion";
import { SendIcon, CloseIcon } from "@/components/shell/icons";
import { SparkIcon, StopIcon } from "./icons";
import { haptic } from "@/components/shell/haptics";
import { cn } from "@/lib/utils";

// Discoverable slash commands. Typing "/" surfaces this menu. Prompt commands
// (compress/summary/cost) are expanded into instructions in useChat.send;
// action commands (new/clear) are intercepted here and run newSession instead.
type SlashCmd = { name: string; desc: string; action?: boolean };
const SLASH_COMMANDS: SlashCmd[] = [
  { name: "compress", desc: "Summarize context, free up tokens" },
  { name: "summary", desc: "Recap decisions and open items" },
  { name: "cost", desc: "Token usage this session" },
  { name: "new", desc: "Start a fresh session", action: true },
  { name: "clear", desc: "Clear this conversation", action: true },
];

// Inline mic glyph (same house style as chat/icons.tsx: 24 viewBox,
// currentColor, round caps). Kept local since icons.tsx is owned elsewhere.
function MicIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

export function Composer({
  onSend,
  onStop,
  onNewSession,
  sending,
  skills,
  onRemoveSkill,
  onOpenSkills,
  contextLabel,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  onNewSession: () => void;
  sending: boolean;
  skills: string[];
  onRemoveSkill: (s: string) => void;
  onOpenSkills: () => void;
  contextLabel: string;
}) {
  const [value, setValue] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Slash-command menu: open while the draft is a bare "/word" with no space.
  const slashQuery =
    value.startsWith("/") && !value.includes(" ") ? value.slice(1).toLowerCase() : null;
  const slashMatches =
    slashQuery !== null
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery))
      : [];
  const slashOpen = slashMatches.length > 0;

  // On-device dictation via the Web Speech API. Free and offline (Safari /
  // WKWebView and Chromium expose it as webkitSpeechRecognition). Feature
  // detected so PWA / Capacitor builds that lack it just hide the mic.
  const [recording, setRecording] = useState(false);
  const [dictationSupported, setDictationSupported] = useState(false);
  // Holds the live SpeechRecognition instance. Untyped because the DOM lib
  // ships no stable types for the (still prefixed) Web Speech API.
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (SR) setDictationSupported(true);
    return () => {
      try {
        recognitionRef.current?.stop();
      } catch {}
    };
  }, []);

  const toggleDictation = () => {
    if (typeof window === "undefined") return;
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SR) return;
    // Second tap stops the active session.
    if (recording) {
      try {
        recognitionRef.current?.stop();
      } catch {}
      return;
    }
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (ev: any) => {
      let transcript = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        transcript += ev.results[i][0].transcript;
      }
      transcript = transcript.trim();
      if (!transcript) return;
      // Append into the existing draft (never auto-send, matching prefill).
      setValue((prev) =>
        prev ? prev.replace(/\s+$/, "") + " " + transcript : transcript,
      );
    };
    rec.onerror = () => setRecording(false);
    rec.onend = () => {
      setRecording(false);
      recognitionRef.current = null;
    };
    recognitionRef.current = rec;
    try {
      rec.start();
      setRecording(true);
      haptic(8);
      requestAnimationFrame(() => taRef.current?.focus());
    } catch {
      setRecording(false);
      recognitionRef.current = null;
    }
  };

  // Prefill from the Tasks home (Suggested chip / voice dictation). Drops the
  // text in and focuses; never auto-sends so the user reviews first. Rides the
  // same window CustomEvent bus as cross-tab nav.
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      setValue((prev) => (prev ? prev + " " + text : text));
      requestAnimationFrame(() => taRef.current?.focus());
    };
    window.addEventListener("lo-prefill", onPrefill as EventListener);
    return () => window.removeEventListener("lo-prefill", onPrefill as EventListener);
  }, []);

  // Auto-grow up to a cap.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [value]);

  const runCommand = (c: SlashCmd) => {
    haptic(10);
    setValue("");
    if (c.action) {
      // /new and /clear both reset to a fresh session locally.
      onNewSession();
      return;
    }
    onSend("/" + c.name);
  };

  const submit = () => {
    const t = value.trim();
    if (!t || sending) return;
    // A bare "/cmd" matching a known command runs that command.
    if (t.startsWith("/") && !t.includes(" ")) {
      const hit = SLASH_COMMANDS.find((c) => c.name === t.slice(1).toLowerCase());
      if (hit) {
        runCommand(hit);
        return;
      }
    }
    haptic([6, 4, 8]);
    onSend(t);
    setValue("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      // Enter with the menu open picks the top match.
      if (slashOpen) {
        runCommand(slashMatches[0]);
        return;
      }
      submit();
    }
  };

  return (
    <div
      className="border-t border-border px-3 pt-2.5"
      style={{
        background: "var(--background-base)",
        opacity: 0.96,
        backdropFilter: "blur(20px) saturate(150%)",
        WebkitBackdropFilter: "blur(20px) saturate(150%)",
        // Sit flush on the keyboard when open (Telegram-style): the home
        // indicator safe area is covered by the keyboard, so collapse it via
        // --kb-open and keep only a small base pad. Falls back to the full safe
        // area when the keyboard is closed.
        paddingBottom:
          "calc(10px + env(safe-area-inset-bottom) * (1 - var(--kb-open, 0)))",
      }}
    >
      {skills.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {skills.map((s) => (
            <motion.span
              key={s}
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1 rounded-full border border-border bg-[color-mix(in_srgb,var(--midground)_8%,transparent)] py-0.5 pl-2 pr-1 text-[0.7rem] text-midground"
            >
              <SparkIcon width={11} height={11} className="text-text-tertiary" />
              <span className="font-mono-ui">{s}</span>
              <button
                type="button"
                aria-label={`Remove ${s}`}
                onClick={() => onRemoveSkill(s)}
                className="grid h-4 w-4 place-items-center rounded-full text-text-tertiary active:scale-90"
              >
                <CloseIcon width={10} height={10} />
              </button>
            </motion.span>
          ))}
        </div>
      )}

      <div className="relative flex items-end gap-2 rounded-[calc(var(--theme-radius)+6px)] border border-border bg-[color-mix(in_srgb,var(--midground)_4%,transparent)] px-2.5 py-1.5">
        <span className="arc-border opacity-0 transition-opacity focus-within:opacity-100" aria-hidden />
        {slashOpen && (
          <div className="absolute bottom-[calc(100%+8px)] left-0 right-0 z-20 overflow-hidden rounded-[var(--radius-md)] border border-border bg-[var(--background-base)]/95 backdrop-blur-xl">
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                onClick={() => runCommand(c)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors active:bg-[color-mix(in_srgb,var(--midground)_8%,transparent)]",
                  i === 0 && "bg-[color-mix(in_srgb,var(--midground)_6%,transparent)]",
                )}
              >
                <span className="font-mono-ui text-[0.78rem] text-midground">/{c.name}</span>
                <span className="truncate text-[0.66rem] text-text-tertiary">{c.desc}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-label="Skills"
          onClick={() => {
            haptic(8);
            onOpenSkills();
          }}
          className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-tertiary transition-colors active:bg-[color-mix(in_srgb,var(--midground)_8%,transparent)] active:text-midground"
        >
          <SparkIcon width={18} height={18} />
        </button>

        {dictationSupported && (
          <button
            type="button"
            aria-label={recording ? "Stop dictation" : "Dictate"}
            aria-pressed={recording}
            onClick={toggleDictation}
            className={cn(
              "mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full transition-colors active:bg-[color-mix(in_srgb,var(--midground)_8%,transparent)]",
              recording
                ? "text-[color-mix(in_srgb,var(--color-destructive)_90%,transparent)]"
                : "text-text-tertiary active:text-midground",
            )}
          >
            {recording ? (
              <motion.span
                animate={{ opacity: [1, 0.35, 1], scale: [1, 1.12, 1] }}
                transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                className="grid place-items-center"
              >
                <MicIcon width={18} height={18} />
              </motion.span>
            ) : (
              <MicIcon width={18} height={18} />
            )}
          </button>
        )}
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            // iOS keyboard takes a frame to open. Scroll after layout settles.
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                const msgList = document.querySelector("[data-msg-scroll]");
                if (msgList) msgList.scrollTop = msgList.scrollHeight;
              });
            });
          }}
          rows={1}
          inputMode="text"
          placeholder={`Message ${contextLabel}`}
          className="scrollbar-none max-h-[140px] min-h-[28px] flex-1 resize-none bg-transparent py-1 text-[0.8rem] leading-relaxed text-text-primary outline-none placeholder:text-text-tertiary"
        />

        {sending ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={() => {
              haptic(12);
              onStop();
            }}
            className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-destructive)_85%,transparent)] text-white transition-transform active:scale-90"
          >
            <StopIcon width={15} height={15} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            disabled={!value.trim()}
            onClick={submit}
            className={cn(
              "mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full transition-all active:scale-90",
              value.trim()
                ? "bg-midground text-background-base"
                : "bg-[color-mix(in_srgb,var(--midground)_12%,transparent)] text-text-tertiary",
            )}
          >
            <SendIcon width={15} height={15} />
          </button>
        )}
      </div>
    </div>
  );
}
