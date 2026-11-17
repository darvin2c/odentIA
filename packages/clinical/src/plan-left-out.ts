/**
 * Lo que la persona dejó fuera del plan: no lo aceptó (`rechazado`), estaba solo
 * en un camino que no eligió (`no_elegida`) o se cambió por otro tratamiento
 * (`reemplazado`). Su estado puede seguir `pendiente`, pero no se hará: no pide
 * consentimiento en la atención ni en Documentos, y no cuenta como «por
 * ejecutar» ni como tratamiento abierto para recepción. Si después lo acepta
 * (en una revisión, por ejemplo), su decisión cambia y vuelve a contar solo.
 *
 * Una sola regla para el cierre, Documentos, la atención, el odontograma, el
 * plan y la coordinación de recepción: la usan los servicios y las pantallas.
 */
export const LEFT_OUT_DECISIONS = ["rechazado", "no_elegida", "reemplazado"] as const

export function isLeftOut(decisionStatus: string | null | undefined): boolean {
  return (LEFT_OUT_DECISIONS as readonly (string | null | undefined)[]).includes(decisionStatus)
}

/**
 * Lo indicado en la atención que queda para otro día, como lo cuenta su resumen («1 indicado hoy»):
 * sin lo quitado, sin lo que ya se hizo hoy y sin lo que la persona dejó fuera. La exodoncia de la
 * opción B que no eligió no es algo indicado que siga en pie (QA del 16 nov, Q16: el cierre decía
 * «2 indicados hoy · 1 por ejecutar»).
 */
export function indicatedForLater<T extends { id: string; status: string; decisionStatus?: string | null }>(
  indicated: readonly T[],
  doneToday: ReadonlySet<string>,
): T[] {
  return indicated.filter(
    (item) => item.status !== "cancelado" && !doneToday.has(item.id) && !isLeftOut(item.decisionStatus),
  )
}
