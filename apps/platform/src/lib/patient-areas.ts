/**
 * Estructura de la página de una persona (ADR 0029): las pestañas del
 * tablero y sus secciones. La página es la misma antes y después de
 * registrarla: Clínica, Plan y Cobros aparecen cuando ya es paciente.
 *
 * `tab` en la URL identifica la sección (no la pestaña) para conservar los
 * enlaces existentes; la pestaña se deriva de ella. Cada sección declara el
 * permiso que la habilita y si necesita la ficha clínica: es coherencia de
 * navegación, la API autoriza cada bloque por separado.
 */

export const PATIENT_AREAS = [
  { id: "resumen", label: "Resumen" },
  { id: "conversaciones", label: "Conversaciones" },
  { id: "citas", label: "Citas" },
  { id: "clinica", label: "Clínica" },
  { id: "plan", label: "Plan" },
  { id: "cobros", label: "Cobros" },
  { id: "datos", label: "Datos" },
] as const
export type PatientAreaId = (typeof PATIENT_AREAS)[number]["id"]

export const PATIENT_SECTIONS = [
  {
    // Para quien lee la clínica (odontólogo, propietario, administrador) el
    // Resumen ya es el clínico: alergias, «Qué sigue», última atención y
    // próxima cita (decisión 1 de la fase 3, ADR 0035). Recepción y caja ven
    // el de siempre.
    id: "resumen",
    area: "resumen",
    label: "Resumen",
    permission: null,
    patient: false,
  },
  {
    id: "conversaciones",
    area: "conversaciones",
    label: "Conversaciones",
    // Odontología lee conversaciones sin el CRM: ve las suyas, no las oportunidades.
    permission: ["conversations.read", "crm.read"],
    patient: false,
  },
  {
    id: "citas",
    area: "citas",
    label: "Sus citas",
    permission: "appointments.read",
    patient: false,
  },
  // Clínica en cuatro secciones (ADR 0035): Antecedentes, Odontograma,
  // Historia («qué pasó y cuándo») y Documentos («buscar un papel»).
  {
    id: "antecedentes",
    area: "clinica",
    label: "Antecedentes",
    permission: "clinical.read",
    patient: true,
  },
  {
    id: "odontograma",
    area: "clinica",
    label: "Odontograma",
    permission: "clinical.read",
    patient: true,
  },
  {
    // Debajo de Odontograma, como parte de esa sección (issue 49, decisión 1):
    // Clínica sigue con cuatro pestañas y las encías están junto a los dientes.
    id: "periodontograma",
    area: "clinica",
    label: "Periodontograma",
    permission: "clinical.read",
    patient: true,
    parent: "odontograma",
  },
  {
    id: "historia",
    area: "clinica",
    label: "Historia",
    permission: "clinical.read",
    patient: true,
  },
  {
    id: "documentos",
    area: "clinica",
    label: "Documentos",
    permission: "clinical.read",
    patient: true,
  },
  {
    // Una sola sección, sin subpestañas (ADR 0034): «Qué sigue», tratamientos,
    // presupuesto y controles. Cada rol ve lo suyo: quien lee la clínica, todo;
    // recepción, los títulos y estados, el presupuesto como lo ve la persona y
    // los controles; caja, el presupuesto y lo aceptado.
    id: "plan",
    area: "plan",
    label: "Plan",
    permission: ["clinical.read", "budgets.read", "appointments.read"],
    patient: true,
  },
  {
    id: "cuenta",
    area: "cobros",
    label: "Cobros",
    permission: "finance.read",
    patient: true,
  },
  {
    id: "filiacion",
    area: "datos",
    label: "Datos personales",
    permission: "patients.read",
    patient: false,
  },
  {
    id: "contactos",
    area: "datos",
    label: "Personas vinculadas",
    permission: "patients.read",
    patient: false,
  },
  {
    id: "canales",
    area: "datos",
    label: "Canales",
    permission: "crm.read",
    patient: false,
  },
  {
    id: "responsables",
    area: "datos",
    label: "Responsables",
    permission: "patients.read",
    patient: true,
  },
  {
    id: "portal",
    area: "datos",
    label: "Acceso al portal",
    permission: "patients.write",
    patient: true,
  },
  {
    id: "accesos",
    area: "datos",
    label: "Consultas a la historia",
    permission: "audit.read",
    patient: true,
  },
] as const satisfies ReadonlyArray<{
  id: string
  area: PatientAreaId
  label: string
  /** Un permiso, cualquiera de varios, o `null`: basta poder ver a las personas. */
  permission: string | readonly string[] | null
  /** Permiso que hace redundante la sección: quien lo tiene no la ve. */
  unless?: string
  /** Necesita la historia clínica: aparece cuando la persona ya es paciente. */
  patient: boolean
  /** Va debajo de otra sección: no suma una pestaña, se elige dentro de ella. */
  parent?: string
}>

export type PatientSection = (typeof PATIENT_SECTIONS)[number]
export type PatientSectionId = PatientSection["id"]
export type Can = (permission: string) => boolean

/**
 * Secciones de la ficha anterior que ya no existen: su enlace guardado abre
 * la sección que hace ese trabajo ahora. «Actividad» repetía citas, historia y
 * conversaciones; «Seguimiento» era el «Contexto» de la Bandeja. Tratamientos,
 * Controles y la coordinación de recepción viven ahora en Plan (ADR 0034). El
 * «Resumen clínico» es el Resumen de quien atiende; Atenciones está dentro de
 * Historia, y cada tipo de papel es un filtro de Documentos (ADR 0035).
 */
const RETIRED_SECTIONS: Record<string, PatientSectionId> = {
  actividad: "resumen",
  seguimiento: "conversaciones",
  recorrido: "plan",
  controles: "plan",
  coordinacion: "plan",
  clinico: "resumen",
  atenciones: "historia",
  imagenes: "documentos",
  recetas: "documentos",
  ordenes: "documentos",
  formularios: "documentos",
  consentimientos: "documentos",
}

/**
 * Filtros de Documentos («buscar un papel»): lo que requiere acción y cada
 * tipo de papel. Van en `?tipo=`; sin filtro se ven todos.
 */
export const DOCUMENT_FILTERS = [
  { id: "requieren", label: "Requieren acción" },
  { id: "recetas", label: "Recetas" },
  { id: "ordenes", label: "Órdenes" },
  { id: "consentimientos", label: "Consentimientos" },
  { id: "formularios", label: "Formularios" },
  { id: "imagenes", label: "Imágenes" },
  // Solo en clínicas de Perú, donde el odontograma se firma (ADR 0036).
  { id: "odontogramas", label: "Odontogramas" },
] as const
export type DocumentFilter = (typeof DOCUMENT_FILTERS)[number]["id"]

export function isDocumentFilter(value: unknown): value is DocumentFilter {
  return DOCUMENT_FILTERS.some((filter) => filter.id === value)
}

/** La sección de un `?tab=`, también de los enlaces de la ficha anterior. */
export function sectionFromSearch(value: unknown): PatientSectionId | undefined {
  if (typeof value !== "string") return undefined
  if (isPatientSectionId(value)) return value
  return RETIRED_SECTIONS[value]
}

/**
 * El filtro de Documentos de un enlace: `?tipo=` o, en un enlace de la ficha
 * anterior, la pestaña de ese tipo (`?tab=recetas` abre Documentos › Recetas).
 */
export function documentFilterFromSearch(tab: unknown, tipo: unknown): DocumentFilter | undefined {
  if (isDocumentFilter(tipo)) return tipo
  return isDocumentFilter(tab) ? tab : undefined
}

/**
 * Qué es la persona para la página: con ficha (`true`), por registrar
 * (`false`) o solo responsable de otros (`"responsable"`: sin citas propias,
 * las de quien está a su cargo están en la página de ese paciente).
 */
export type PageOf = boolean | "responsable"

/** Secciones que el rol puede abrir para esta persona, en el orden de navegación. */
export function visibleSections(can: Can, isPatient: PageOf = true): PatientSection[] {
  return PATIENT_SECTIONS.filter((section) => {
    if (section.patient && isPatient !== true) return false
    if (isPatient === "responsable" && section.area === "citas") return false
    const permission: string | readonly string[] | null = section.permission
    // Ninguna sección usa hoy `unless`; se conserva la regla para la próxima que lo necesite.
    const unless = (section as { unless?: string }).unless
    if (unless && can(unless)) return false
    if (permission === null) return can("patients.read")
    return typeof permission === "string" ? can(permission) : permission.some(can)
  })
}

export function isPatientSectionId(value: unknown): value is PatientSectionId {
  return PATIENT_SECTIONS.some((section) => section.id === value)
}

export function sectionOf(id: PatientSectionId): PatientSection {
  const found = PATIENT_SECTIONS.find((section) => section.id === id)
  if (!found) throw new RangeError(`Sección de ficha desconocida: ${id}`)
  return found
}

/**
 * Sección de entrada según el trabajo del rol (ADR 0035): quien solo cobra
 * abre los cobros del paciente; el resto, el Resumen. Para quien lee la
 * clínica ese Resumen es el clínico: abrir la página es una lectura clínica y
 * queda en «Consultas a la historia». Para recepción y caja no lo es.
 */
export function defaultSection(can: Can, isPatient: PageOf = true): PatientSectionId {
  if (isPatient === true && can("finance.read") && !can("clinical.read") && !can("patients.write"))
    return "cuenta"
  return "resumen"
}

/** El Resumen de la persona es el clínico para quien lee la historia y ella ya es paciente. */
export function clinicalSummaryFor(can: Can, isPatient: PageOf = true): boolean {
  return isPatient === true && can("clinical.read")
}

/** La sección pedida si el rol puede verla; si no, su entrada por defecto o la primera visible. */
export function resolveSection(
  requested: PatientSectionId | undefined,
  can: Can,
  isPatient: PageOf = true,
): PatientSectionId | null {
  const visible = visibleSections(can, isPatient)
  if (visible.length === 0) return null
  if (requested && visible.some((section) => section.id === requested)) return requested
  const preferred = defaultSection(can, isPatient)
  return visible.some((section) => section.id === preferred) ? preferred : visible[0].id
}

export interface AreaNavEntry {
  /** Id de la sección: valor de la pestaña de segundo nivel. */
  value: PatientSectionId
  label: string
}

/** La sección de la que cuelga otra (Periodontograma → Odontograma); ella misma si no cuelga de ninguna. */
export function navSectionOf(id: PatientSectionId): PatientSectionId {
  const parent = (sectionOf(id) as { parent?: PatientSectionId }).parent
  return parent ?? id
}

/** Entradas de segundo nivel de una pestaña: sus secciones visibles, sin las que cuelgan de otra. */
export function areaNav(area: PatientAreaId, can: Can, isPatient: PageOf = true): AreaNavEntry[] {
  return visibleSections(can, isPatient)
    .filter((section) => section.area === area && !(section as { parent?: string }).parent)
    .map((section) => ({ value: section.id, label: section.label }))
}

/**
 * Lo que se elige dentro de una sección con secciones debajo: ella y las suyas
 * («Odontograma · Periodontograma»). Vacío si no tiene ninguna visible.
 */
export function subsectionNav(id: PatientSectionId, can: Can, isPatient: PageOf = true): AreaNavEntry[] {
  const parent = navSectionOf(id)
  const visible = visibleSections(can, isPatient)
  const children = visible.filter((section) => (section as { parent?: string }).parent === parent)
  if (children.length === 0) return []
  const own = visible.find((section) => section.id === parent)
  return [...(own ? [own] : []), ...children].map((section) => ({ value: section.id, label: section.label }))
}

/** Pestañas con al menos una sección visible y la sección que abre cada una. */
export function visibleAreas(
  can: Can,
  isPatient: PageOf = true,
): Array<{ id: PatientAreaId; label: string; target: PatientSectionId }> {
  const sections = visibleSections(can, isPatient)
  const preferred = defaultSection(can, isPatient)
  return PATIENT_AREAS.flatMap((area) => {
    const own = sections.filter((section) => section.area === area.id)
    if (own.length === 0) return []
    const target = own.find((section) => section.id === preferred) ?? own[0]
    return [{ id: area.id, label: area.label, target: target.id }]
  })
}

/** Dentición que corresponde mostrar por edad; el clínico puede cambiarla. */
export type Dentition = "adult" | "mixed" | "primary"

/**
 * Recambio dentario habitual: temporal hasta los 5 años, mixta de 6 a 12 y
 * permanente desde los 13. Sin fecha de nacimiento no se supone una edad.
 */
export function suggestedDentition(
  birthDate: string | null | undefined,
  today = new Date(),
): Dentition | null {
  if (!birthDate) return null
  const born = new Date(birthDate)
  if (Number.isNaN(born.getTime())) return null
  let age = today.getFullYear() - born.getFullYear()
  const month = today.getMonth() - born.getMonth()
  if (month < 0 || (month === 0 && today.getDate() < born.getDate())) age -= 1
  if (age < 0) return null
  if (age <= 5) return "primary"
  if (age <= 12) return "mixed"
  return "adult"
}
