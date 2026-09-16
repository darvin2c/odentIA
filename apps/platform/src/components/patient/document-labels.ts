import { timeAgo } from "../../lib/crm";
import type { Encounter, PlanItem } from "../../lib/patients";

export const UPLOAD_CATEGORIES = ["radiografia", "foto_clinica", "consentimiento", "informe", "otro"] as const;

const CATEGORY_LABELS: Record<string, string> = {
  radiografia: "Radiografía",
  foto_clinica: "Foto clínica",
  consentimiento: "Consentimiento",
  informe: "Informe",
  otro: "Otro",
};

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
export const ACCEPT_ATTR = ACCEPTED_TYPES.join(",");
export const MAX_BYTES = 10 * 1024 * 1024;

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function encounterLabel(e: Encounter): string {
  const when = timeAgo(e.createdAt);
  return `${when}${e.reason ? ` · ${e.reason}` : ""} · ${e.status}`;
}

export function planItemLabel(p: PlanItem): string {
  return `${p.title}${p.toothNumber != null ? ` · Pieza ${p.toothNumber}` : ""}`;
}

/** Nombre base sin extensión para proponer el título de cada archivo. */
export function basenameWithoutExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim() || "Documento";
}
