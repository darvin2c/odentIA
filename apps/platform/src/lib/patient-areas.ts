/**
 * Estructura de la ficha: cinco áreas de trabajo y sus secciones.
 *
 * `tab` en la URL identifica la sección (no el área) para conservar los
 * enlaces existentes; el área se deriva de ella. Cada sección declara el
 * permiso que la habilita: es coherencia de navegación, la API autoriza.
 */

export const PATIENT_AREAS = [
  { id: "resumen", label: "Resumen" },
  { id: "clinica", label: "Clínica" },
  { id: "relacion", label: "Relación" },
  { id: "cuenta", label: "Cuenta" },
  { id: "datos", label: "Datos" },
] as const
export type PatientAreaId = (typeof PATIENT_AREAS)[number]["id"]

/** Agrupa en una sola entrada de navegación lo que la atención emite o adjunta. */
export const DOCUMENTS_GROUP = { id: "documentos", label: "Documentos" } as const

export const PATIENT_SECTIONS = [
  { id: "resumen", area: "resumen", label: "Resumen", permission: null, group: null },
  {
    id: "odontograma",
    area: "clinica",
    label: "Odontograma y plan",
    permission: "clinical.read",
    group: null,
  },
  {
    id: "recorrido",
    area: "clinica",
    label: "Tratamientos",
    permission: "clinical.read",
    group: null,
  },
  {
    id: "plan",
    area: "clinica",
    label: "Planes y presupuestos",
    permission: "clinical.read",
    group: null,
  },
  {
    id: "controles",
    area: "clinica",
    label: "Controles",
    permission: "clinical.read",
    group: null,
  },
  {
    id: "atenciones",
    area: "clinica",
    label: "Atenciones",
    permission: "clinical.read",
    group: null,
  },
  { id: "historia", area: "clinica", label: "Historia", permission: "clinical.read", group: null },
  {
    id: "antecedentes",
    area: "clinica",
    label: "Antecedentes",
    permission: "clinical.read",
    group: null,
  },
  {
    id: "documentos",
    area: "clinica",
    label: "Todos",
    permission: "clinical.read",
    group: "documentos",
  },
  {
    id: "imagenes",
    area: "clinica",
    label: "Imágenes y archivos",
    permission: "clinical.read",
    group: "documentos",
  },
  {
    id: "recetas",
    area: "clinica",
    label: "Recetas",
    permission: "clinical.read",
    group: "documentos",
  },
  {
    id: "ordenes",
    area: "clinica",
    label: "Órdenes",
    permission: "clinical.read",
    group: "documentos",
  },
  {
    id: "formularios",
    area: "clinica",
    label: "Formularios",
    permission: "clinical.read",
    group: "documentos",
  },
  {
    id: "consentimientos",
    area: "clinica",
    label: "Consentimientos",
    permission: "clinical.read",
    group: "documentos",
  },
  {
    id: "actividad",
    area: "relacion",
    label: "Actividad",
    permission: ["appointments.read", "crm.read"],
    group: null,
  },
  { id: "citas", area: "relacion", label: "Citas", permission: "appointments.read", group: null },
  {
    id: "coordinacion",
    area: "relacion",
    label: "Tratamiento",
    permission: "appointments.read",
    // Quien lee la clínica ya tiene el plan completo en su área.
    unless: "clinical.read",
    group: null,
  },
  {
    id: "seguimiento",
    area: "relacion",
    label: "Seguimiento",
    permission: "crm.read",
    group: null,
  },
  {
    id: "contactos",
    area: "relacion",
    label: "Interlocutores",
    // Quien gestiona la filiación o conversa; caja ve al pagador en Responsables.
    permission: ["patients.write", "conversations.read"],
    group: null,
  },
  { id: "cuenta", area: "cuenta", label: "Cuenta", permission: "finance.read", group: null },
  { id: "filiacion", area: "datos", label: "Filiación", permission: "patients.read", group: null },
  {
    id: "responsables",
    area: "datos",
    label: "Responsables",
    permission: "patients.read",
    group: null,
  },
  {
    id: "portal",
    area: "datos",
    label: "Acceso al portal",
    permission: "patients.write",
    group: null,
  },
  {
    id: "accesos",
    area: "datos",
    label: "Consultas a la historia",
    permission: "audit.read",
    group: null,
  },
] as const satisfies ReadonlyArray<{
  id: string
  area: PatientAreaId
  label: string
  /** Un permiso, cualquiera de varios, o `null`: basta poder leer la ficha. */
  permission: string | readonly string[] | null
  /** Permiso que hace redundante la sección: quien lo tiene no la ve. */
  unless?: string
  group: typeof DOCUMENTS_GROUP.id | null
}>

export type PatientSection = (typeof PATIENT_SECTIONS)[number]
export type PatientSectionId = PatientSection["id"]
export type Can = (permission: string) => boolean

const ANY_READ = ["patients.read", "clinical.read", "finance.read"]

/** Secciones que el rol puede abrir, en el orden de navegación. */
export function visibleSections(can: Can): PatientSection[] {
  return PATIENT_SECTIONS.filter((section) => {
    const permission: string | readonly string[] | null = section.permission
    const unless: string | undefined = "unless" in section ? section.unless : undefined
    if (unless && can(unless)) return false
    if (permission === null) return ANY_READ.some(can)
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
 * Sección de entrada según el trabajo del rol: quien solo cobra abre la
 * cuenta; el resto, el resumen. Para quien atiende el resumen es clínico
 * (atención en curso, alertas, pendientes e imágenes) y el odontograma queda
 * a un clic: la ficha no se organiza alrededor del odontograma.
 */
export function defaultSection(can: Can): PatientSectionId {
  if (can("finance.read") && !can("clinical.read") && !can("patients.write")) return "cuenta"
  return "resumen"
}

/** La sección pedida si el rol puede verla; si no, su entrada por defecto o la primera visible. */
export function resolveSection(
  requested: PatientSectionId | undefined,
  can: Can,
): PatientSectionId | null {
  const visible = visibleSections(can)
  if (visible.length === 0) return null
  if (requested && visible.some((section) => section.id === requested)) return requested
  const preferred = defaultSection(can)
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

/** Entradas de segundo nivel de un área: secciones simples y grupos colapsados en una. */
export function areaNav(area: PatientAreaId, can: Can): AreaNavEntry[] {
  const entries: AreaNavEntry[] = []
  for (const section of visibleSections(can)) {
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

/** Áreas con al menos una sección visible y la sección que abre cada una. */
export function visibleAreas(
  can: Can,
): Array<{ id: PatientAreaId; label: string; target: PatientSectionId }> {
  const sections = visibleSections(can)
  const preferred = defaultSection(can)
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
