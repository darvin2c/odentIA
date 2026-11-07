/**
 * Al abrir una pantalla sin permiso, el guardia de `_org` lleva a Inicio con la
 * sección en el enlace (`?sinAcceso=commissions`) y ahí se dice por qué. Volver
 * a Inicio sin decir nada parecía un error. Solo se nombran las secciones de
 * esta lista: el texto del enlace nunca se muestra tal cual.
 */
const SECTION_NAMES: Record<string, string> = {
  people: "Pacientes",
  patients: "Pacientes",
  contacts: "Pacientes",
  inbox: "Bandeja",
  opportunities: "Oportunidades",
  pipeline: "Oportunidades",
  tasks: "Tareas",
  services: "Servicios y precios",
  commissions: "Comisiones",
  finance: "Finanzas",
  inventory: "Inventario",
  reports: "Reportes",
  agent: "Agente",
  settings: "Configuración",
  members: "Configuración",
  branches: "Configuración",
}

/** La sección de una ruta, como viaja en `?sinAcceso=`. */
export function noAccessSection(pathname: string): string {
  return pathname.split("/").filter(Boolean)[0] ?? ""
}

/** El nombre que ve la persona, o null si el enlace no trae una sección conocida. */
export function noAccessName(section: string | undefined): string | null {
  if (!section) return null
  return Object.hasOwn(SECTION_NAMES, section) ? SECTION_NAMES[section]! : null
}
