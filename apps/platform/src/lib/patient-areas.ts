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

/** Agrupa en una sola entrada de navegación lo que la atención emite o adjunta. */
export const DOCUMENTS_GROUP = { id: "documentos", label: "Documentos" } as const

export const PATIENT_SECTIONS = [
  {
    id: "resumen",
    area: "resumen",
    label: "Resumen",
    permission: null,
    patient: false,
    group: null,
  },
  {
    id: "conversaciones",
    area: "conversaciones",
    label: "Conversaciones",
    // Odontología lee conversaciones sin el CRM: ve las suyas, no las oportunidades.
    permission: ["conversations.read", "crm.read"],
    patient: false,
    group: null,
  },
  {
    id: "citas",
    area: "citas",
    label: "Sus citas",
    permission: "appointments.read",
    patient: false,
    group: null,
  },
  {
    id: "clinico",
    area: "clinica",
    label: "Resumen clínico",
    permission: "clinical.read",
    patient: true,
    group: null,
  },
  {
    id: "odontograma",
    area: "clinica",
    label: "Odontograma",
    permission: "clinical.read",
    patient: true,
    group: null,
  },

  {
    id: "atenciones",
    area: "clinica",
    label: "Atenciones",
    permission: "clinical.read",
    patient: true,
    group: null,
  },
  {
    id: "historia",
    area: "clinica",
    label: "Historia",
    permission: "clinical.read",
    patient: true,
    group: null,
  },
  {
    id: "antecedentes",
    area: "clinica",
    label: "Antecedentes",
    permission: "clinical.read",
    patient: true,
    group: null,
  },
  {
    id: "documentos",
    area: "clinica",
    label: "Todos",
    permission: "clinical.read",
    patient: true,
    group: "documentos",
  },
  {
    id: "imagenes",
    area: "clinica",
    label: "Imágenes y archivos",
    permission: "clinical.read",
    patient: true,
    group: "documentos",
  },
  {
    id: "recetas",
    area: "clinica",
    label: "Recetas",
    permission: "clinical.read",
    patient: true,
    group: "documentos",
  },
  {
    id: "ordenes",
    area: "clinica",
    label: "Órdenes",
    permission: "clinical.read",
    patient: true,
    group: "documentos",
  },
  {
    id: "formularios",
    area: "clinica",
    label: "Formularios",
    permission: "clinical.read",
    patient: true,
    group: "documentos",
  },
  {
    id: "consentimientos",
    area: "clinica",
    label: "Consentimientos",
    permission: "clinical.read",
    patient: true,
    group: "documentos",
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
    group: null,
  },
  {
    id: "cuenta",
    area: "cobros",
    label: "Cobros",
    permission: "finance.read",
    patient: true,
    group: null,
  },
  {
    id: "filiacion",
    area: "datos",
    label: "Datos personales",
    permission: "patients.read",
    patient: false,
    group: null,
  },
  {
    id: "contactos",
    area: "datos",
    label: "Personas vinculadas",
    permission: "patients.read",
    patient: false,
    group: null,
  },
  {
    id: "canales",
    area: "datos",
    label: "Canales",
    permission: "crm.read",
    patient: false,
    group: null,
  },
  {
    id: "responsables",
    area: "datos",
    label: "Responsables",
    permission: "patients.read",
    patient: true,
    group: null,
  },
  {
    id: "portal",
    area: "datos",
    label: "Acceso al portal",
    permission: "patients.write",
    patient: true,
    group: null,
  },
  {
    id: "accesos",
    area: "datos",
    label: "Consultas a la historia",
    permission: "audit.read",
    patient: true,
    group: null,
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
  group: typeof DOCUMENTS_GROUP.id | null
}>

export type PatientSection = (typeof PATIENT_SECTIONS)[number]
export type PatientSectionId = PatientSection["id"]
export type Can = (permission: string) => boolean

/**
 * Secciones de la ficha anterior que ya no existen: su enlace guardado abre
 * la sección que hace ese trabajo ahora. «Actividad» repetía citas, historia y
 * conversaciones; «Seguimiento» era el «Contexto» de la Bandeja. Tratamientos,
 * Controles y la coordinación de recepción viven ahora en Plan (ADR 0034).
 */
const RETIRED_SECTIONS: Record<string, PatientSectionId> = {
  actividad: "resumen",
  seguimiento: "conversaciones",
  recorrido: "plan",
  controles: "plan",
  coordinacion: "plan",
}

/** La sección de un `?tab=`, también de los enlaces de la ficha anterior. */
export function sectionFromSearch(value: unknown): PatientSectionId | undefined {
  if (typeof value !== "string") return undefined
  if (isPatientSectionId(value)) return value
  return RETIRED_SECTIONS[value]
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
 * Sección de entrada según el trabajo del rol: quien solo cobra abre los
 * cobros del paciente; el resto, el resumen. Lo clínico queda a un clic, en
 * su pestaña: abrir la página no es leer la historia.
 */
export function defaultSection(can: Can, isPatient: PageOf = true): PatientSectionId {
  if (isPatient === true && can("finance.read") && !can("clinical.read") && !can("patients.write"))
    return "cuenta"
  return "resumen"
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
  /** Id de sección o de grupo: valor de la pestaña de segundo nivel. */
  value: string
  label: string
  /** Sección que se abre al elegir la entrada. */
  target: PatientSectionId
  /** Secciones del grupo; vacío cuando la entrada es una sección simple. */
  members: PatientSection[]
}

/** Entradas de segundo nivel de una pestaña: secciones simples y grupos colapsados en una. */
export function areaNav(area: PatientAreaId, can: Can, isPatient: PageOf = true): AreaNavEntry[] {
  const entries: AreaNavEntry[] = []
  for (const section of visibleSections(can, isPatient)) {
    if (section.area !== area) continue
    if (section.group === null) {
      entries.push({ value: section.id, label: section.label, target: section.id, members: [] })
      continue
    }
    const group = entries.find((entry) => entry.value === section.group)
    if (group) group.members.push(section)
    else
      entries.push({
        value: DOCUMENTS_GROUP.id,
        label: DOCUMENTS_GROUP.label,
        target: section.id,
        members: [section],
      })
  }
  return entries
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
