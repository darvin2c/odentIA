import type { ConsentDocument } from "./clinical-forms"

/**
 * Lo que vio quien firma (revisión de las reglas clínicas del 18 nov): el servidor solo firma si los
 * riesgos propios siguen siendo los de la hoja que leyó. En la tablet es la hoja en pantalla; en
 * papel, la que salió de aquí impresa, descargada o abierta aparte. Se recuerda mientras dura esta
 * pestaña; si la hoja salió de otro equipo, vale la que se tiene a la vista.
 */
const printed = new Map<string, string[]>()

export function personalRisksOf(document: Pick<ConsentDocument, "sectionsSnapshot">): string[] {
  return document.sectionsSnapshot?.personalRisks ?? []
}

/** La hoja de este consentimiento salió a papel con los riesgos que tiene ahora. */
export function rememberPrintedSheet(
  document: Pick<ConsentDocument, "id" | "sectionsSnapshot">,
): void {
  printed.set(document.id, personalRisksOf(document))
}

/** Los riesgos propios de la hoja impresa; sin impresión desde aquí, los de la hoja a la vista. */
export function personalRisksOnPaper(
  document: Pick<ConsentDocument, "id" | "sectionsSnapshot">,
): string[] {
  return printed.get(document.id) ?? personalRisksOf(document)
}

/** Lo que va en la firma: sin riesgos no se manda nada (para el servidor, la hoja no tenía). */
export function shownRisksField(risks: string[]): { personalRisksShown?: string[] } {
  return risks.length > 0 ? { personalRisksShown: risks } : {}
}
