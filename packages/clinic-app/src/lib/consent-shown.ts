import type { ConsentDocument } from "./clinical-forms"

/**
 * Lo que vio quien firma (revisión de las reglas clínicas del 18 nov): el servidor solo firma si los
 * riesgos propios siguen siendo los de la hoja que leyó. En la tablet es la hoja en pantalla; en
 * papel, la que salió impresa, descargada o abierta aparte, que anota el servidor al salir
 * (`markConsentPrinted`): así vale aunque la pestaña se recargue o la hoja salga de otro equipo.
 */
export function personalRisksOf(document: Pick<ConsentDocument, "sectionsSnapshot">): string[] {
  return document.sectionsSnapshot?.personalRisks ?? []
}

/** Lo que va en la firma: sin riesgos no se manda nada (para el servidor, la hoja no tenía). */
export function shownRisksField(risks: string[]): { personalRisksShown?: string[] } {
  return risks.length > 0 ? { personalRisksShown: risks } : {}
}
