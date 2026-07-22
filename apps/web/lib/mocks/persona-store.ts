"use client";

// Dev convenience only: lets Phase 1 UI exercise all three portal shells
// against MSW without three real Supabase users. Read only when
// NEXT_PUBLIC_API_MOCKING is enabled (see lib/api/client.ts wiring).
const STORAGE_KEY = "zm_mock_persona";

export function getStoredPersona(): string {
  if (typeof window === "undefined") return "supplier-owner";
  return window.localStorage.getItem(STORAGE_KEY) ?? "supplier-owner";
}

export function setStoredPersona(persona: string) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, persona);
  window.dispatchEvent(new CustomEvent("zm:persona-changed"));
}
