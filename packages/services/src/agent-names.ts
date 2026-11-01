/**
 * Los nombres de los agentes (issue 183): cada uno con un porqué, para que nadie
 * los confunda con una persona del equipo ni con un rol. En el código siguen sus
 * ids de rol (`recepcion`, `asistente_clinico`, `administrador`); lo que se ve
 * dice el nombre.
 *
 * Sofi es el nombre por defecto del agente de recepción: cada clínica puede
 * cambiarlo (`agent_config.persona_name`) y el cambio vale solo para esa
 * clínica. Clío, Argos y Ariadna son fijos.
 */
export const RECEPTION_DEFAULT_NAME = "Sofi"

export const AGENT_NAMES = {
  recepcion: RECEPTION_DEFAULT_NAME,
  asistente_clinico: "Clío",
  administrador: "Argos",
  ayuda: "Ariadna",
} as const

/** El rol que acompaña al nombre la primera vez que aparece: «Sofi, tu agente de recepción». */
export const AGENT_ROLE_WORDS = {
  recepcion: "tu agente de recepción",
  asistente_clinico: "tu agente clínico",
  administrador: "tu agente administrador",
  ayuda: "tu guía del sistema",
} as const

/** El porqué de cada nombre: va de subtítulo en la página de cada agente. */
export const AGENT_NAME_REASONS = {
  recepcion: "De sophía, sabiduría: sabe todo de la clínica y responde con su tono, a cualquier hora.",
  asistente_clinico: "La musa de la historia: escribe la historia clínica mientras el odontólogo atiende.",
  administrador: "El gigante de los cien ojos: ve toda la clínica y no deja a ningún paciente atrás.",
  ayuda: "La del hilo del laberinto: te lleva hasta donde está cada cosa.",
} as const

/** El nombre del agente de recepción de una clínica: el que eligió o, sin elegir, Sofi. */
export function receptionName(personaName: string | null | undefined): string {
  return personaName?.trim() || RECEPTION_DEFAULT_NAME
}

/**
 * Los textos fijos (catálogos, ayuda, líneas) nombran al agente de recepción
 * como «Sofi». Al mostrarlos en una clínica que le puso otro nombre, se dice el
 * suyo: el cambio vale solo para esa clínica.
 */
export function withReceptionName(text: string, name: string): string {
  return name === RECEPTION_DEFAULT_NAME ? text : text.replace(/\bSofi\b/g, name)
}
