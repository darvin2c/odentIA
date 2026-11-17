/**
 * «Descartar esta atención» (QA del 16 nov, B3d): la borra de un toque, sin motivo ni rastro,
 * así que solo se ofrece con la atención vacía de verdad. Lo guardado lo dice el servidor
 * (`empty` de la atención abierta); lo de la página, esta regla: nada escrito, aunque aún no se
 * guarde (el motivo recién escrito), nada indicado y ningún bloque con algo. Lo traído por su
 * cita («Hoy viene a…») no la llena: el servidor la descarta igual. Antes seguía a la vista
 * después de indicar y daba un error sin salida, y borraba un motivo recién escrito.
 */
export function discardableHere(page: {
  /** Lo escrito en la página: motivo, relato, tiempo, evolución, indicaciones y pronóstico. */
  texts: readonly string[]
  /** Lo indicado en esta atención y vigente. */
  indicated: number
  /** Los bloques de la atención con su `empty`; «consulta» y «plan» los cubren `texts` e `indicated`. */
  sections: ReadonlyArray<{ key: string; empty: boolean }>
}): boolean {
  return (
    page.texts.every((text) => text.trim() === "") &&
    page.indicated === 0 &&
    page.sections.every((section) => section.empty || section.key === "plan" || section.key === "consulta")
  )
}
