import { fractionDigits } from "../dinero.js"

/**
 * La comprobación antes de enviar una respuesta de Sofi (paso B5), como `verifyReply` en las
 * clínicas: lo que el modelo escribe no sale si dice algo que no salió de sus herramientas.
 *
 * - Cada importe con moneda tiene que ser uno que vio en este turno (catálogo, cotización,
 *   pedido), uno de la tienda (el envío) o uno que ya se dijo en la conversación.
 * - Cada porcentaje, uno de una promoción que vio o uno que escribió el cliente.
 * - Nunca dice que un pago está confirmado o recibido si ningún pedido de la conversación tiene
 *   dinero confirmado: una captura queda por confirmar (tablero 8).
 * - Nunca dice que hizo algo que no hizo para vender (tablero 21): «hablé con la tienda», «le
 *   pregunté al dueño», ni que separa el producto (gestorIA todavía no separa stock).
 *
 * Si algo no pasa, Sofi lo corrige una vez; si vuelve a fallar, no sale y la conversación pasa
 * a una persona (`sofi.ts`).
 */

const NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`

function symbolsOf(currency: string): string[] {
  const parts = new Intl.NumberFormat("es-PE", { style: "currency", currency }).formatToParts(1)
  const symbol = parts.find((p) => p.type === "currency")?.value ?? currency
  const list = new Set([symbol, currency])
  if (currency === "PEN") list.add("S/.").add("S/")
  if (symbol.includes("$")) list.add("$")
  return [...list].sort((a, b) => b.length - a.length)
}

const WORDS: Record<string, string> = { PEN: "soles?", USD: "d[oó]lares?", EUR: "euros?" }

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")

/** Un número escrito («1,290.50», «129,90», «129») en la unidad menor de la moneda. */
function centsOfText(raw: string, currency: string): number | null {
  const digits = fractionDigits(currency)
  let whole = raw
  let fraction = ""
  const last = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","))
  if (last >= 0) {
    const tail = raw.slice(last + 1)
    // Dos separadores, o uno con 1 o 2 cifras detrás: es el decimal. Uno con 3: son miles.
    if (tail.length <= 2) {
      whole = raw.slice(0, last)
      fraction = tail
    }
  }
  const integer = Number(whole.replace(/[.,]/g, ""))
  if (!Number.isFinite(integer)) return null
  const minor = Number((fraction || "0").padEnd(digits, "0").slice(0, Math.max(digits, 1)))
  return integer * 10 ** digits + (digits === 0 ? 0 : minor)
}

/** Los importes con moneda que dice un texto, en la unidad menor. */
export function amountsIn(text: string, currency: string): number[] {
  const symbols = symbolsOf(currency).map(escapeRegex).join("|")
  const word = WORDS[currency]
  const before = new RegExp(`(?:${symbols})\\s?(${NUMBER})`, "gi")
  const after = word ? new RegExp(`(${NUMBER})\\s?${word}(?![\\p{L}])`, "giu") : null
  const found: number[] = []
  for (const match of text.matchAll(before)) {
    const cents = centsOfText(match[1]!, currency)
    if (cents !== null) found.push(cents)
  }
  if (after)
    for (const match of text.matchAll(after)) {
      const cents = centsOfText(match[1]!, currency)
      if (cents !== null) found.push(cents)
    }
  return found
}

/** Los porcentajes de un texto («10 %», «15%»). */
export function percentsIn(text: string): number[] {
  return [...text.matchAll(/(\d{1,3})\s?%/g)].map((m) => Number(m[1]))
}

const PAID = [
  /\b(?:ya\s+)?(?:est[aá]|qued[oó]|fue|figura)\s+(?:pagad[oa]|confirmad[oa]|aprobad[oa])/giu,
  /\bpago\s+(?:est[aá]\s+|qued[oó]\s+|fue\s+|ya\s+)?(?:confirmado|aprobado|recibido|verificado)/giu,
  /\brecib(?:imos|í|i|ido)\s+(?:tu|su|el)\s+pago/giu,
  /\b(?:confirm(?:amos|é)|verific(?:amos|qué)|valid(?:amos|é))\s+(?:tu|su|el)\s+pago/giu,
  /\b(?:tu|su)\s+pedido\s+(?:ya\s+)?est[aá]\s+pagado/giu,
]
/**
 * Lo que niega o pone condición justo antes: «no está confirmado», «todavía no está pagado»,
 * «cuando tu pago esté confirmado». Pegado a lo que dice, sin puntuación entre medio: «No te
 * preocupes, ya está pagado» o «Si, recibimos tu pago» sí dan el pago por confirmado.
 */
const NEGATION =
  /(?:\b(?:no|ni)\s+(?:(?:ya|aún|todavía|se|lo|te|me)\s+)?|\b(?:cuando|apenas|si|hasta que|en cuanto)\s+(?:[^\s.,;:!?¡¿]+\s+){0,3})$/iu

/** Si el texto da un pago por confirmado o recibido (no cuenta lo negado ni lo condicional). */
export function claimsPaid(text: string): boolean {
  for (const pattern of PAID)
    for (const match of text.matchAll(pattern)) {
      const lead = text.slice(Math.max(0, match.index - 30), match.index)
      if (!NEGATION.test(lead)) return true
    }
  return false
}

/** Alguien de la tienda con quien Sofi diría que habló para conseguir algo («te consigo» sí vale). */
const PEOPLE = String.raw`(?:la\s+tienda|(?:el|la|mi)\s+(?:due[ñn][oa]|jef[ea]|encargad[oa]|gerente|equipo)|mis\s+jef[ea]s)`
const INVENTED = [
  new RegExp(
    String.raw`\b(?:habl[eé]|convers[eé]|consult[eé]|coordin[eé]|negoci[eé])\s+con\s+${PEOPLE}`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:le\s+)?pregunt[eé]\s+(?:a\s+${PEOPLE}|al\s+(?:due[ñn]o|jefe|encargado|gerente|equipo))`,
    "iu",
  ),
  new RegExp(String.raw`\b${PEOPLE}\s+(?:me\s+)?(?:autoriz[oó]|aprob[oó]|acept[oó])`, "iu"),
]
/**
 * Separar el producto todavía no existe: el stock baja al pagar. Mientras no se programe, Sofi no
 * lo promete. Cuando exista, esta regla se quita.
 */
const HOLDS =
  /\b(?:te\s+(?:lo|la|los|las)\s+(?:separo|reservo|guardo|aparto)|(?:queda|est[aá]|va)\s+separad[oa]s?\s+para\s+ti)/iu

/** Si el texto dice que habló con alguien de la tienda o que separa el producto. */
export function claimsInvented(text: string): boolean {
  return [...INVENTED, HOLDS].some((pattern) => pattern.test(text))
}

export interface KnownFacts {
  currency: string
  /** Los importes que se pueden decir, en la unidad menor. */
  amounts: ReadonlySet<number>
  percents: ReadonlySet<number>
  /** Algún pedido de la conversación ya tiene dinero confirmado. */
  paid: boolean
}

/** Lo que no pasa de una respuesta, en palabras para que el modelo lo corrija. */
export function checkReply(text: string, known: KnownFacts): string[] {
  const problems: string[] = []
  const unknown = [...new Set(amountsIn(text, known.currency))].filter((a) => !known.amounts.has(a))
  if (unknown.length > 0)
    problems.push(
      `Estos importes no salieron de tus herramientas ni de la tienda: ${unknown
        .map((a) => a / 10 ** fractionDigits(known.currency))
        .join(", ")}. Usa solo los que te dieron (cotizar si negocias).`,
    )
  const percents = [...new Set(percentsIn(text))].filter((p) => !known.percents.has(p))
  if (percents.length > 0)
    problems.push(
      `Estos porcentajes no son de una promoción de la tienda: ${percents.join(", ")} %. Habla en importes que salgan de cotizar.`,
    )
  if (!known.paid && claimsPaid(text))
    problems.push(
      "Ningún pago de esta conversación está confirmado: no lo des por pagado. Una captura queda por confirmar y la revisa una persona.",
    )
  if (claimsInvented(text))
    problems.push(
      "No digas que hablaste con la tienda o con alguien del equipo, ni que separas el producto: eso no pasó. Di «te consigo» y el plazo para pagar.",
    )
  if (text.length > 900) problems.push("Es muy largo: escríbelo en menos de 900 caracteres.")
  return problems
}
