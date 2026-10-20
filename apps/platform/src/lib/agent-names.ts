import { useOrgProfile } from "./org"

/**
 * Los nombres de los agentes (issue 183), los mismos que `@odentia/services`
 * (`agent-names.ts`). En el código siguen sus ids de rol; lo que se ve dice el
 * nombre. El de recepción lo elige cada clínica y vale solo para ella: se lee
 * con `useReceptionName`. Clío y Argos son fijos.
 */
export const RECEPTION_DEFAULT_NAME = "Sofi"
export const CLINICAL_NAME = "Clío"
export const ADMIN_NAME = "Argos"

/** El porqué de cada nombre: subtítulo en la página de cada agente. */
export const AGENT_NAME_REASONS = {
  recepcion: "De sophía, sabiduría: sabe todo de la clínica y responde con su tono, a cualquier hora.",
  asistente_clinico: "La musa de la historia: escribe la historia clínica mientras el odontólogo atiende.",
  administrador: "El gigante de los cien ojos: ve toda la clínica y no deja a ningún paciente atrás.",
} as const

/** El nombre del agente de recepción de esta clínica; mientras carga, Sofi. */
export function useReceptionName(): string {
  return useOrgProfile().data?.receptionName?.trim() || RECEPTION_DEFAULT_NAME
}

/** El nombre de cada agente por su id de rol, con el de recepción de esta clínica. */
export function useAgentNames(): Record<"recepcion" | "asistente_clinico" | "administrador", string> {
  const reception = useReceptionName()
  return { recepcion: reception, asistente_clinico: CLINICAL_NAME, administrador: ADMIN_NAME }
}

/**
 * Los textos fijos que llegan del servidor (catálogo, ayuda, líneas) nombran al
 * agente de recepción como «Sofi»: en una clínica que le puso otro nombre, se dice el suyo.
 */
export function withReceptionName(text: string, name: string): string {
  return name === RECEPTION_DEFAULT_NAME ? text : text.replace(/\bSofi\b/g, name)
}

/** Lo mismo en todos los textos de un valor del servidor (objetos y listas); las claves no cambian. */
export function withReceptionNameIn<T>(value: T, name: string): T {
  if (name === RECEPTION_DEFAULT_NAME) return value
  if (typeof value === "string") return withReceptionName(value, name) as T
  if (Array.isArray(value)) return value.map((item) => withReceptionNameIn(item, name)) as T
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withReceptionNameIn(item, name)])) as T
  }
  return value
}
