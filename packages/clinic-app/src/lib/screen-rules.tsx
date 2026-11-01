import type { FilterDef, PageHeaderMenuItem, PageHeaderPrimary } from "@odentia/ui-patterns"
import { Banknote, CalendarCheck, Lock, LogOut, Plus, SquarePen } from "lucide-react"
import type { ReactNode } from "react"
import { productUi } from "../product/product-ui"

/**
 * Lo que cada pantalla ofrece según el rol, en un solo sitio: lo leen la pantalla
 * y su esqueleto para no separarse. Es solo visibilidad; autoriza el servidor.
 * Liviano a propósito (sin consultas ni cajones): baja con el arranque, junto a
 * los esqueletos.
 *
 * Cada acción recibe `run` con lo que hace al pulsarla; sin él (el esqueleto, que
 * aún no tiene la pantalla) la misma acción se dibuja deshabilitada.
 */

export type Can = (permission: string) => boolean

function action(label: string, icon: ReactNode, run?: () => void): PageHeaderPrimary {
  return run ? { label, icon, onClick: run } : { label, icon, disabled: true }
}

function menuItem(label: string, run: (() => void) | undefined, icon?: ReactNode): PageHeaderMenuItem {
  return run ? { label, icon, onSelect: run } : { label, icon, disabled: true }
}

const PLUS = <Plus aria-hidden />

// --- Finanzas -------------------------------------------------------------------------------

export function financeAccess(can: Can) {
  return {
    write: can("finance.write"),
    close: can("finance.close"),
    commissions: can("commissions.read"),
    commissionsWrite: can("commissions.write"),
    settings: can("settings.write"),
    reports: can("reports.read"),
    /** «Escribirle» en Deudas. */
    message: can("conversations.read"),
  }
}
export type FinanceAccess = ReturnType<typeof financeAccess>

/** En el escritorio, la acción principal de la sección y lo demás en ⋯. */
export function financeHeader(
  view: string,
  access: FinanceAccess,
  run?: { collect: () => void; close: () => void; expense: () => void },
): { primary?: PageHeaderPrimary; menu: PageHeaderMenuItem[] } {
  const primary =
    (view === "caja" || view === "cobros" || view === "deudas") && access.write
      ? action("Cobrar", <Banknote aria-hidden />, run?.collect)
      : view === "caja" && access.close
        ? action("Cerrar caja", <Lock aria-hidden />, run?.close)
        : view === "gastos" && access.write
          ? action("Registrar gasto", PLUS, run?.expense)
          : undefined
  const menu =
    view === "caja" && access.write
      ? [
          menuItem("Registrar gasto", run?.expense, PLUS),
          ...(access.close ? [menuItem("Cerrar caja", run?.close, <Lock aria-hidden />)] : []),
        ]
      : []
  return { primary, menu }
}

export interface FinancePhoneAction {
  key: "collect" | "close" | "expense"
  label: string
  /** El botón lleno; el otro va con borde. */
  filled: boolean
}

/** En el teléfono, la barra siempre a la vista: cobrar y cerrar sin desplazarse. */
export function financePhoneActions(view: string, access: FinanceAccess): FinancePhoneAction[] {
  const collect: FinancePhoneAction = { key: "collect", label: "Cobrar", filled: true }
  if (view === "caja") {
    return [
      ...(access.close ? [{ key: "close" as const, label: "Cerrar caja", filled: false }] : []),
      ...(access.write ? [collect] : []),
    ]
  }
  if ((view === "cobros" || view === "deudas") && access.write) return [collect]
  if (view === "gastos" && access.write) return [{ key: "expense", label: "Registrar gasto", filled: true }]
  return []
}

// --- Comisiones -----------------------------------------------------------------------------

export const COMMISSIONS_ADMIN_SUBTITLE = "Lo que le corresponde a cada profesional por lo que atendió y ya se cobró"

/** Quien administra ve el mes de toda la clínica; quien solo tiene `commissions.read`, «Mis comisiones». */
export function commissionsHeading(can: Can, myName: string | undefined): { canWrite: boolean; title: string; subtitle: string | undefined } {
  const canWrite = can("commissions.write")
  return { canWrite, title: canWrite ? "Comisiones" : "Mis comisiones", subtitle: canWrite ? COMMISSIONS_ADMIN_SUBTITLE : myName }
}

// --- Inventario -----------------------------------------------------------------------------

export function inventoryAccess(can: Can) {
  const write = can("inventory.write")
  return { prices: can("inventory.read"), write, receive: can("inventory.receive") || write }
}
export type InventoryAccess = ReturnType<typeof inventoryAccess>

/** La acción principal crea lo que cada pestaña lista; lo demás de Productos va en ⋯. */
export function inventoryHeader(
  tab: string,
  access: InventoryAccess,
  options?: {
    /** «Trasladar» pide más de una sede. Mientras no se sabe, no se ofrece. */
    manyBranches: boolean
    run?: {
      product: () => void
      purchase: () => void
      supplier: () => void
      count: () => void
      adjust: () => void
      transfer: () => void
      use: () => void
      add: () => void
      paste: () => void
    }
  },
): { primary?: PageHeaderPrimary; menu?: PageHeaderMenuItem[] } {
  const run = options?.run
  const primary = !access.write
    ? undefined
    : tab === "productos"
      ? action("Producto", PLUS, run?.product)
      : tab === "compras"
        ? action("Compra", PLUS, run?.purchase)
        : tab === "proveedores"
          ? action("Proveedor", PLUS, run?.supplier)
          : undefined
  const menu: PageHeaderMenuItem[] = []
  if (access.write) menu.push(menuItem("Contar", run?.count))
  if (access.write) menu.push(menuItem("Ajustar", run?.adjust))
  if (access.write && options?.manyBranches) menu.push(menuItem("Trasladar", run?.transfer))
  if (access.receive) menu.push(menuItem("Registrar uso", run?.use))
  if (access.write) menu.push(menuItem("Agregar sin compra", run?.add))
  if (access.write) menu.push(menuItem("Pegar mi lista", run?.paste))
  return { primary, menu: tab === "productos" && menu.length > 0 ? menu : undefined }
}

/** El conteo se abre con `?contar=si`, solo para quien puede ajustar lo que hay. */
export function inventoryCounting(contar: string | undefined, access: InventoryAccess): boolean {
  return contar === "si" && access.write
}

export function inventoryCountPrimary(run?: () => void): PageHeaderPrimary {
  return action("Salir sin guardar", <LogOut aria-hidden />, run)
}

/** Las vistas de Compras: «Por pagar» pide ver precios y «Borradores», poder pedir. */
export function purchaseViews(access: InventoryAccess): Array<{ value: "por_llegar" | "por_pagar" | "borradores" | "todas"; label: string }> {
  return [
    { value: "por_llegar", label: "Por llegar" },
    ...(access.prices ? [{ value: "por_pagar" as const, label: "Por pagar" }] : []),
    ...(access.write ? [{ value: "borradores" as const, label: "Borradores" }] : []),
    { value: "todas", label: "Todas" },
  ]
}

// --- Pacientes y la página de la persona -----------------------------------------------------

/** Registrar un paciente es el botón principal; un contacto (aún no es paciente), su menú. */
export function peopleHeader(can: Can, run?: { patient: () => void; contact: () => void }): { primary?: PageHeaderPrimary; menu?: PageHeaderMenuItem[] } {
  const canRegister = can("patients.write")
  const canCreate = canRegister || can("crm.write")
  return {
    primary: canRegister
      ? action("Nuevo paciente", PLUS, run?.patient)
      : canCreate
        ? action("Nuevo contacto", PLUS, run?.contact)
        : undefined,
    menu: canRegister ? [menuItem("Nuevo contacto", run?.contact)] : undefined,
  }
}

/** Quien aún no es paciente solo lo ven recepción y quien dirige; caja y odontología, solo pacientes. */
export function peopleSubtitle(can: Can): string {
  return can("crm.read") ? "Todas las personas de la clínica: pacientes, contactos nuevos y sus familiares" : "Los pacientes de la clínica"
}

/** Lo que la cabecera de la persona ofrece según el rol; lo demás (archivada, sus datos) lo decide la cabecera. */
export function personHeaderRules(can: Can, hasPatient: boolean) {
  const canEncounter = can("clinical.write")
  const canBook = can("appointments.write")
  const canMessage = can("conversations.write")
  const primary = hasPatient
    ? canEncounter
      ? ("encounter" as const)
      : canBook
        ? ("book" as const)
        : can("finance.write")
          ? ("charge" as const)
          : null
    : canMessage
      ? ("write" as const)
      : null
  return {
    primary,
    message: canMessage,
    /** A quien aún no es paciente se le reserva con su ficha mínima, que lee el CRM. */
    book: canBook && (hasPatient || can("crm.read")),
    encounter: hasPatient && canEncounter,
    /** Cambiar a la persona: con ficha, quien edita la filiación; sin ella, también quien lleva el CRM. */
    edit: hasPatient ? can("patients.write") : can("patients.write") || can("crm.write"),
  }
}

// --- Agenda, Tareas, Oportunidades y Bandeja -------------------------------------------------

export function agendaHeader(
  can: Can,
  run?: { book: () => void; calendar: () => void },
): { primary?: PageHeaderPrimary; secondary?: { label: string; icon: ReactNode; onClick?: () => void; disabled?: boolean } } {
  return {
    secondary: can("clinical.write")
      ? { label: "Mi calendario", icon: <CalendarCheck aria-hidden />, ...(run ? { onClick: run.calendar } : { disabled: true }) }
      : undefined,
    primary: can("appointments.write") ? action("Nueva cita", PLUS, run?.book) : undefined,
  }
}

export function tasksPrimary(can: Can, run?: () => void): PageHeaderPrimary | undefined {
  return can("tasks.write") ? action("Nueva tarea", PLUS, run) : undefined
}

/** «Toda la clínica» solo la ven el propietario y el administrador. */
export function tasksFilters(can: Can): FilterDef[] {
  return can("tasks.all") ? [{ key: "alcance", label: "Alcance", type: "select", options: [{ value: "clinica", label: "Toda la clínica" }] }] : []
}

export function pipelinePrimary(can: Can, run?: () => void): PageHeaderPrimary | undefined {
  return can("crm.write") ? action("Nueva oportunidad", PLUS, run) : undefined
}

/** «Nueva conversación» lee a la persona en el CRM: quien no lo ve (odontología) no recibe el botón. */
export function inboxPrimary(can: Can, run?: () => void): PageHeaderPrimary | undefined {
  return can("conversations.write") && can("crm.read") ? action("Nueva conversación", <SquarePen className="size-4" aria-hidden />, run) : undefined
}

// --- Servicios ------------------------------------------------------------------------------

/**
 * Si el producto registra dónde se hace un servicio (odentIA: pieza, caras,
 * cuadrante…). En latidIA todo es general (decisión 4 del issue 229): el
 * ámbito no se elige ni se muestra.
 */
export function hasPlaces(): boolean {
  return productUi().site !== null
}

/** Materiales de cada servicio (ADR 0067): los ve quien ve Inventario y los configura quien lo lleva. */
export function servicesAccess(can: Can) {
  return {
    manage: can("settings.write"),
    seesMaterials: can("inventory.read") || can("inventory.stock"),
    writeMaterials: can("inventory.write"),
  }
}

export function servicesHeader(can: Can, run?: { add: () => void; own: () => void }): { primary?: PageHeaderPrimary; menu?: PageHeaderMenuItem[] } {
  return can("settings.write")
    ? { primary: action("Agregar servicios", PLUS, run?.add), menu: [menuItem("Crear un servicio propio", run?.own)] }
    : {}
}

/** Quien no administra el tarifario solo consulta la biblioteca. */
export function libraryHeading(can: Can): { canIncorporate: boolean; title: string; subtitle: string } {
  const canIncorporate = can("settings.write")
  return {
    canIncorporate,
    title: canIncorporate ? "Agregar servicios" : "Biblioteca de procedimientos",
    subtitle: canIncorporate
      ? "Elige de la biblioteca o crea los tuyos, y pon el precio aquí mismo. Lo que guardes queda activo."
      : "Lo que la clínica puede agregar a sus servicios. Los agrega quien administra la clínica.",
  }
}

export function libraryPrimary(can: Can, run?: () => void): PageHeaderPrimary | undefined {
  return can("settings.write") ? action("Crear un servicio propio", PLUS, run) : undefined
}

export function promotionsPrimary(can: Can, run?: () => void): PageHeaderPrimary | undefined {
  return can("settings.write") ? action("Nueva promoción", PLUS, run) : undefined
}

// --- Configuración --------------------------------------------------------------------------

const SETTINGS_PRIMARY = {
  branches: { permission: "settings.write", label: "Nueva sede" },
  team: { permission: "settings.write", label: "Invitar al equipo" },
  specialties: { permission: "settings.write", label: "Agregar especialidad" },
  /** Campos y etapas de venta los define también quien trabaja con ventas. */
  fields: { permission: "crm.write", label: "Nuevo campo" },
  paymentMethods: { permission: "settings.write", label: "Agregar medio de pago" },
} as const

export function settingsPrimary(screen: keyof typeof SETTINGS_PRIMARY, can: Can, run?: () => void): PageHeaderPrimary | undefined {
  const rule = SETTINGS_PRIMARY[screen]
  return can(rule.permission) ? action(rule.label, PLUS, run) : undefined
}

// --- Agente ---------------------------------------------------------------------------------

// Lo que espera el sí de la persona vive en la Bandeja, no en una pestaña (ADR 0118).
const AGENT_TABS = [
  { label: "Resumen", to: "/agent", key: "resumen", permission: "read" },
  { label: "Actividad", to: "/agent/actividad", key: "actividad", permission: "decide" },
  { label: "Aprender", to: "/agent/learn", key: "aprender", permission: "read" },
  { label: "Conocimiento", to: "/agent/knowledge", key: "conocimiento", permission: "write" },
] as const

/** Cada pestaña aparece solo con el permiso que su ruta exige. Con una sola no hay pestañas. */
export function agentTabsFor(can: Can) {
  const visible = AGENT_TABS.filter((tab) => (tab.permission === "read" ? can("agent.read") : can("agent.write")))
  return visible.length < 2 ? [] : visible
}

/** «Confirmó por teléfono» reserva y responde: lo hace quien decide, escribe y agenda. */
export function canConfirmByPhone(can: Can): boolean {
  return can("agent.decide") && can("conversations.write") && can("appointments.write")
}

/** Corregir una respuesta del agente: quien decide por él o quien lo administra. */
export function canCorrectAgent(can: Can): boolean {
  return can("agent.decide") || can("agent.write")
}

/** La columna de «Probar» de recepción: ancho de un chat, que se puede cambiar como el de cualquier panel. */
export const RECEPTION_TEST_COLUMN = { initial: 416, min: 352, max: 560 }

// --- Inicio ---------------------------------------------------------------------------------

export interface HomeToday {
  /** `undecided`: dirige y atiende; qué tarjeta tiene depende de sus citas de hoy, y no se anticipa su título. */
  card: "patients" | "agenda" | "undecided" | "cash" | null
  /** Quien ve la agenda y además la caja la tiene en una línea, debajo. */
  cashLine: boolean
}

/**
 * La tarjeta de hoy, con la misma regla que `getWorkspaceHome` y `accessFor` en el
 * servidor: el odontólogo tiene «Mis pacientes de hoy», quien ve la agenda, la de
 * la sede, y quien solo cobra, la caja. Quien dirige y además atiende tiene «Mis
 * pacientes» si hoy tiene citas propias: un dato que se sabe al llegar.
 */
export function homeToday(role: string, can: Can): HomeToday {
  const finance = can("finance.read")
  if (!can("appointments.read")) return { card: finance ? "cash" : null, cashLine: false }
  return { card: role === "clinician" ? "patients" : can("clinical.write") ? "undecided" : "agenda", cashLine: finance }
}
