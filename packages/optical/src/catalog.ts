/**
 * El catálogo de vistIA: los tipos de servicio de su biblioteca y las
 * especialidades con que nace una óptica. Como en odentIA (ADR 0069) y latidIA,
 * los tipos son de uso interno: ordenan la biblioteca, guardan las palabras de
 * la calle del agente y dicen qué especialidad recibe cada servicio; la óptica ve
 * y edita la especialidad, nunca el tipo.
 *
 * Los lentes, las monturas y las lunas no son servicios: son productos del
 * inventario, que se venden.
 */

export const OPTICAL_SERVICE_KINDS = [
  { key: "examen", name: "Examen de la vista" },
  { key: "contacto", name: "Lentes de contacto" },
  { key: "taller", name: "Anteojos y taller" },
  { key: "pruebas", name: "Pruebas especiales" },
  { key: "terapia", name: "Terapia visual" },
] as const
export type OpticalServiceKind = (typeof OPTICAL_SERVICE_KINDS)[number]["key"]
/** Las claves de los tipos, en su orden. */
export const OPTICAL_SERVICE_KIND_KEYS: readonly OpticalServiceKind[] = OPTICAL_SERVICE_KINDS.map((item) => item.key)

/** Cómo pide la gente cada tipo: así «no veo bien de lejos» encuentra el examen. */
export const OPTICAL_KIND_WORDS: Record<OpticalServiceKind, string> = {
  examen: "examen de la vista, medida, medirme la vista, no veo bien, veo borroso, me duele la cabeza al leer, lentes, anteojos",
  contacto: "lentes de contacto, pupilentes, lentillas, lentes blandos",
  taller: "armar lentes, cambiar las lunas, se rompió la montura, ajustar los lentes, progresivos, bifocales",
  pruebas: "campo visual, fondo de ojo, presión del ojo, topografía, glaucoma",
  terapia: "ojo vago, ojo desviado, estrabismo, terapia visual, ejercicios de los ojos",
}

/**
 * Una especialidad con que nace la óptica. `receives` son los tipos de la
 * biblioteca que la usan (cada tipo va a una sola); `kind` es el que toma un
 * servicio propio de esta especialidad.
 */
export interface OpticalSpecialty {
  key: string
  name: string
  kind: OpticalServiceKind
  receives: readonly OpticalServiceKind[]
}

/**
 * Las tres con que nace toda óptica: la optometría, que examina, prueba y arma
 * los anteojos; la contactología, que adapta lentes de contacto; y la terapia
 * visual. No sale de la norma de un país: es la lista general de vistIA.
 */
export const OPTICAL_SPECIALTIES: readonly OpticalSpecialty[] = [
  { key: "optometria", name: "Optometría", kind: "examen", receives: ["examen", "pruebas", "taller"] },
  { key: "contactologia", name: "Contactología", kind: "contacto", receives: ["contacto"] },
  { key: "terapia_visual", name: "Terapia visual", kind: "terapia", receives: ["terapia"] },
]

/** La única fase del plan de vistIA: lo indicado se hace en el orden en que se indica. */
export const OPTICAL_PLAN_PHASE = "general"
