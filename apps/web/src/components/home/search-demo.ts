// El buscador rápido de la demo de la portada (las dos webs): la misma forma de buscar del producto
// (packages/services/src/global-search.ts y search-text.ts), en el navegador y sobre datos de ejemplo.
// Por letras sin tildes ni mayúsculas, cada palabra por el comienzo de una palabra; los números
// («987 654», «HC-000123», «B001-000245») por sus dígitos. Cada resultado va debajo de su dueño.

/** Los tipos del filtro, en el orden y con los nombres del producto. */
export const DEMO_TYPES = [
  "persona",
  "cita",
  "conversacion",
  "clinica",
  "documento",
  "dinero",
  "tarea",
  "servicio",
  "inventario",
  "equipo",
] as const
export type DemoType = (typeof DEMO_TYPES)[number]

export const DEMO_TYPE_LABELS: Record<DemoType, string> = {
  persona: "Personas",
  cita: "Citas",
  conversacion: "Conversaciones y mensajes",
  clinica: "Historia clínica",
  documento: "Documentos e imágenes",
  dinero: "Dinero",
  tarea: "Tareas",
  servicio: "Servicios y promociones",
  inventario: "Inventario y compras",
  equipo: "Equipo y sedes",
}

export interface DemoItem {
  type: DemoType
  /** La palabra de la fila: «Cita», «Mensaje», «Presupuesto»… */
  kind: string
  title: string
  /** Lo de la derecha: estado, monto, fecha. */
  meta?: string
  /** Lo que dice Enter en el producto: «Ver en la Agenda». */
  verb: string
  /** Número de un presupuesto o comprobante, para buscarlo por su número. */
  number?: number
  /**
   * Lo de hoy y lo pendiente (la próxima cita, la última conversación, el saldo, el presupuesto por
   * aceptar): se ve debajo de quien se encontró por su nombre, su teléfono o su historia. Lo demás
   * (historia clínica, documentos, mensajes) aparece solo cuando lo que se escribe lo encuentra.
   */
  pending?: boolean
}

export interface DemoOwner {
  id: string
  type: DemoType
  title: string
  badge: string
  detail?: string
  verb: string
  /** Teléfonos y documentos, solo dígitos. */
  phones?: string[]
  docs?: string[]
  /** Número de historia: 123 es «HC-000123». */
  hc?: number
  /** Más texto por el que se encuentra una cosa (no una persona), como su especialidad. */
  also?: string
  items: DemoItem[]
}

export interface SearchDemoData {
  /** «odentIA» o «latidIA». */
  product: string
  /** El agente que responde preguntas de los datos. */
  agent: string
  /** La clínica de la demo, en la barra de arriba. */
  clinic: string
  owners: DemoOwner[]
  /** Ids de las personas «Abiertas hace poco». */
  recents: string[]
  /** «Ir a»: las pantallas del menú. */
  screens: string[]
  /** Las búsquedas que se escriben solas y las fichas para probar. */
  examples: string[]
}

export interface ResultOwner {
  owner: DemoOwner
  items: DemoItem[]
  more: number
}

export interface DemoResult {
  owners: ResultOwner[]
  screens: string[]
  /** Parece una pregunta: «Preguntarle a Argos» va primero. */
  question: boolean
}

/** Cuántas cosas se ven debajo de cada dueño antes de «+ N más» (como el producto). */
const PER_OWNER = 4
const MAX_OWNERS = 6

export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es")
}

function words(text: string): string[] {
  return fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Cada palabra escrita es el comienzo de alguna palabra del texto: «lucia» encuentra «Lucía Ramos». */
export function wordsMatch(query: string, text: string): boolean {
  const asked = words(query)
  if (!asked.length) return false
  const have = words(text)
  return asked.every((word) => have.some((w) => w.startsWith(word)))
}

/** Dígitos de una búsqueda que parece un número (search-text.ts): vacío si hay menos de 4 o si casi todo son letras. */
export function searchDigits(q: string): string {
  const text = q.trim()
  const digits = text.replace(/\D/g, "")
  const compact = text.replace(/\s/g, "")
  if (digits.length < 4 || digits.length < compact.length * 0.6) return ""
  return digits
}

/** El número de algo escrito con su prefijo o sin él: «HC-000123» o «123» (search-text.ts). */
export function referenceNumber(q: string, prefixes: readonly string[]): number | null {
  const text = q.trim().toLowerCase().replace(/\s+/g, "")
  const match = /^([a-z.º°#]*)-?0*(\d{1,9})$/.exec(text)
  if (!match) return null
  const prefix = (match[1] ?? "").replace(/[.º°#]/g, "")
  if (prefix && !prefixes.includes(prefix) && prefix !== "n") return null
  return Number(match[2])
}

const QUESTION_START =
  /^(cuant[oa]s?|cual(es)?|que|quien(es)?|como|donde|cuando|por que|dime|muestrame)\b/

/** En el producto la decide el modelo; aquí, una pregunta se reconoce por sus signos o su primera palabra. */
export function looksLikeQuestion(q: string): boolean {
  const text = fold(q.trim())
  return (
    text.startsWith("¿") || text.endsWith("?") || QUESTION_START.test(text.replace(/^[¿¡]+/, ""))
  )
}

export function searchDemo(
  data: SearchDemoData,
  q: string,
  hidden: readonly DemoType[] = [],
): DemoResult {
  const text = q.trim()
  const off = (type: DemoType) => hidden.includes(type)
  const question = looksLikeQuestion(text)
  const digits = searchDigits(text)
  const hc = referenceNumber(text, ["hc"])
  // El número de un comprobante o presupuesto: «B001-000245» → 245, «P-0045» → 45.
  const docNumber = digits ? Number(digits.slice(-6)) : referenceNumber(text, ["p", "b001"])

  const itemMatches = (item: DemoItem) =>
    !off(item.type) &&
    (item.number != null && docNumber != null
      ? item.number === docNumber
      : !digits && wordsMatch(text, `${item.kind} ${item.title}`))

  const matched: ResultOwner[] = []
  const byItems: ResultOwner[] = []
  for (const owner of data.owners) {
    const person = owner.type === "persona"
    const ownerMatches =
      !off(owner.type) &&
      (person
        ? (!digits && wordsMatch(text, owner.title)) ||
          (!!digits &&
            [...(owner.phones ?? []), ...(owner.docs ?? [])].some((d) => d.includes(digits))) ||
          (hc != null && owner.hc === hc)
        : !digits && wordsMatch(text, `${owner.title} ${owner.also ?? ""}`))
    const found = owner.items.filter(itemMatches)
    if (!ownerMatches && !found.length) continue
    // A quien se encontró se le ve, después de lo que coincide, lo suyo de hoy y pendiente; a los demás, solo lo que coincide.
    const items = ownerMatches
      ? [
          ...found,
          ...owner.items.filter((item) => item.pending && !off(item.type) && !found.includes(item)),
        ]
      : found
    const result = {
      owner,
      items: items.slice(0, PER_OWNER),
      more: Math.max(items.length - PER_OWNER, 0),
    }
    ;(ownerMatches ? matched : byItems).push(result)
  }
  // Primero las personas que coinciden, después las cosas que coinciden y al final quien solo tiene algo que coincide.
  matched.sort((a, b) => Number(b.owner.type === "persona") - Number(a.owner.type === "persona"))
  const folded = fold(text)
  return {
    owners: [...matched, ...byItems].slice(0, MAX_OWNERS),
    screens: text ? data.screens.filter((screen) => fold(screen).includes(folded)).slice(0, 4) : [],
    question,
  }
}
