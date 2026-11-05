/**
 * El examen de la boca de odentIA (ADR 0003; NTS 139: el examen extraoral e
 * intraoral va en la historia): extraoral, intraoral e higiene oral. Sus
 * datos y su nombre en palabras viven aquí, para que el servidor (la copia de
 * la historia) y la pantalla (la atención firmada) digan lo mismo.
 */

export const DENTAL_EXAM_EXTRAORAL = ["atm", "ganglios", "labios"] as const
export const DENTAL_EXAM_INTRAORAL = ["encias", "lengua", "paladar", "pisoBoca", "carrillos", "orofaringe"] as const
export const DENTAL_EXAM_HYGIENE = ["buena", "regular", "mala"] as const

/** El nombre de cada dato como lo ve quien escribe el examen. */
export const DENTAL_EXAM_LABELS: Record<string, string> = {
  atm: "ATM",
  ganglios: "Ganglios",
  labios: "Labios",
  encias: "Encías",
  lengua: "Lengua",
  paladar: "Paladar",
  pisoBoca: "Piso de boca",
  carrillos: "Carrillos",
  orofaringe: "Orofaringe",
}

const GROUPS = [
  { key: "extraoral", label: "Extraoral", fields: DENTAL_EXAM_EXTRAORAL },
  { key: "intraoral", label: "Intraoral", fields: DENTAL_EXAM_INTRAORAL },
] as const

const HYGIENE_WORDS: Record<string, string> = { buena: "buena", regular: "regular", mala: "mala" }

/**
 * El examen guardado, una línea por parte: «Extraoral · ATM: sin chasquido;
 * Labios: secos», «Intraoral · Encías: inflamadas», «Higiene oral: regular».
 * Lo que no se escribió no sale; sin nada escrito, ninguna línea.
 */
export function dentalExamLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const exam = value as Record<string, unknown>
  const lines: string[] = []
  for (const group of GROUPS) {
    const given = exam[group.key]
    if (!given || typeof given !== "object" || Array.isArray(given)) continue
    const parts = group.fields
      .map((field) => {
        const text = (given as Record<string, unknown>)[field]
        return typeof text === "string" && text.trim() ? `${DENTAL_EXAM_LABELS[field] ?? field}: ${text.trim()}` : null
      })
      .filter((part): part is string => part !== null)
    if (parts.length) lines.push(`${group.label} · ${parts.join("; ")}`)
  }
  const hygiene = exam["higieneOral"]
  if (typeof hygiene === "string" && HYGIENE_WORDS[hygiene]) lines.push(`Higiene oral: ${HYGIENE_WORDS[hygiene]}`)
  return lines
}
