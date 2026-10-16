/**
 * Odontograma firmado (solo en clínicas de un país con odontograma oficial:
 * NTS 188 en Perú; ADR 0036). Sus momentos son los de la norma (5.10 y 5.11):
 * al iniciar el plan de tratamiento, cuando aparecen hallazgos nuevos, al
 * culminar el plan, a pedido judicial o de la persona, y el reingreso tras
 * culminar, que abre uno nuevo. Los tres primeros los firma el cierre de la
 * atención que cambió el gráfico; los otros, el botón «Firmar odontograma».
 */

export const SIGNED_ODONTOGRAM_PURPOSES = [
  "initial",
  "new_findings",
  "completion",
  "reentry",
  "legal",
  "personal",
] as const
export type SignedOdontogramPurpose = (typeof SIGNED_ODONTOGRAM_PURPOSES)[number]

/** Lo que firma el cierre de la atención, sin que nadie lo elija. */
export type ClosingOdontogramPurpose = Extract<
  SignedOdontogramPurpose,
  "initial" | "new_findings" | "completion"
>

/** Lo que solo se firma con el botón «Firmar odontograma». */
export const MANUAL_SIGNED_ODONTOGRAM_PURPOSES = ["legal", "personal", "reentry"] as const
export type ManualOdontogramPurpose = (typeof MANUAL_SIGNED_ODONTOGRAM_PURPOSES)[number]

/** Cómo se dice el momento en el documento y en el cierre. */
export const SIGNED_ODONTOGRAM_PURPOSE_LABELS: Record<SignedOdontogramPurpose, string> = {
  initial: "Inicio del plan de tratamiento",
  new_findings: "Nuevos hallazgos",
  completion: "Culminación del plan de tratamiento",
  reentry: "Reingreso",
  legal: "A pedido judicial",
  personal: "A pedido de la persona",
}

/** Cómo se dice en una fila de la lista («15 oct · Inicio del plan · Ana Torres»). */
export const SIGNED_ODONTOGRAM_PURPOSE_SHORT: Record<SignedOdontogramPurpose, string> = {
  initial: "Inicio del plan",
  new_findings: "Nuevos hallazgos",
  completion: "Culminación",
  reentry: "Reingreso",
  legal: "Pedido judicial",
  personal: "Pedido de la persona",
}

export function isSignedOdontogramPurpose(value: unknown): value is SignedOdontogramPurpose {
  return typeof value === "string" && (SIGNED_ODONTOGRAM_PURPOSES as readonly string[]).includes(value)
}

/**
 * El momento del odontograma que firma el cierre de una atención que cambió
 * el gráfico. `previous` son los momentos ya firmados de la persona, del más
 * antiguo al más reciente; los pedidos (judicial, personal) no cuentan, porque
 * no abren ni cierran un plan. Sin ninguno, o tras una culminación, empieza un
 * plan («Inicio del plan»); si con esta atención no le queda nada por hacer al
 * plan, es la «Culminación»; si no, «Nuevos hallazgos».
 */
export function closingOdontogramPurpose(
  previous: readonly string[],
  culminated: boolean,
): ClosingOdontogramPurpose {
  const clinical = previous.filter((purpose) => purpose !== "legal" && purpose !== "personal")
  const last = clinical.at(-1)
  if (!last || last === "completion") return "initial"
  return culminated ? "completion" : "new_findings"
}
