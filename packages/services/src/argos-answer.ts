/**
 * La respuesta de Argos sobre las vistas del negocio (ADR 0075): lo que hace
 * falta antes de llamar a los modelos, la frase con huecos llenada con el
 * resultado y el registro de cada pregunta. El modelo nunca ve el resultado:
 * escribe la frase con `{columna}`, `{lista}` y `{filas}` y aquí se llenan,
 * con el formato de la clínica.
 *
 * Cada pregunta deja una fila en `report_question` con la consulta que corrió
 * y cómo terminó, nunca el texto (decisión D2). Las que pasaron por el modelo
 * cuentan para `REPORT_DAILY_LIMIT`; las que fallaron por el modelo o la base
 * no (decisión D6: el costo lo asume odentIA).
 */
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { product } from "@odentia/db/schema/inventory"
import { reportQuestion } from "@odentia/db/schema/reports"
import { and, asc, count, eq, gte, ne } from "drizzle-orm"
import { getAdminSettings } from "./agent-admin.js"
import { formatServiceIndex, listAgentServices } from "./agent-clinic-info.js"
import { type ArgosKey, argosViewsOf } from "./argos-catalog.js"
import { listArgosBranches } from "./argos-period.js"
import { ARGOS_LIST_ROWS, type ArgosQueryResult } from "./argos-query.js"
import type { ArgosStoredPlan } from "./argos-saved.js"
import { getOrgLocale, type OrgLocale } from "./locale.js"
import { REPORT_DAILY_LIMIT } from "./report-ask.js"
import { type ReportQuery, reportScope } from "./report-scope.js"

export const ARGOS_WORDS = {
  // Se ven en Reportes y en el buscador: no nombran una pantalla.
  apagado: "Argos está apagado. Enciéndelo para preguntarle.",
  tope: `La clínica llegó a las ${REPORT_DAILY_LIMIT} preguntas de las últimas 24 horas. En unas horas sigo respondiendo.`,
  sinModelo: "Ahora no puedo leer preguntas. Prueba de nuevo en un momento.",
  noPudo: "No pude calcular eso. Prueba a decirlo de otra forma o con un periodo más corto.",
  tiempo: "La consulta tardaba más de 3 segundos y la detuve. Prueba con un periodo más corto.",
  noExiste: "Eso no está en los datos que registra odentIA.",
  ayuda: "Eso es de cómo se usa odentIA: te lo explica la Ayuda.",
  otro: "Respondo preguntas sobre los datos de la clínica: dinero, pacientes, agenda, tratamientos, presupuestos e inventario. Prueba con «¿cuánto cobramos este mes?».",
} as const

export type ArgosOutcome = "respondida" | "parcial" | "no_sabe" | "ayuda" | "otro" | "no_pudo"

/** Lo que hace falta antes de llamar a los modelos: si Argos está encendido, si queda tope y el formato de la clínica. */
export async function prepareArgosQuestion(
  tx: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<{ enabled: boolean; roomLeft: number; zone: OrgLocale }> {
  const { enabled } = await getAdminSettings(tx, orgId)
  const [row] = await tx
    .select({ total: count() })
    .from(reportQuestion)
    .where(
      and(
        eq(reportQuestion.organizationId, orgId),
        eq(reportQuestion.usedModel, true),
        ne(reportQuestion.outcome, "no_pudo"),
        gte(reportQuestion.createdAt, new Date(now.getTime() - 86_400_000)),
      ),
    )
  return { enabled, roomLeft: Math.max(0, REPORT_DAILY_LIMIT - Number(row?.total ?? 0)), zone: await getOrgLocale(tx, orgId) }
}

/**
 * Los nombres de la clínica tal como están en las vistas: sedes, equipo,
 * servicios por especialidad y, si la llave ve el inventario, productos. Sin
 * ellos el modelo adivina («Ortodoncia» por «Ortodoncia y Ortopedia
 * Maxilar», «extrac» por «Exodoncia simple», «Surco» por «Sede Surco») y la
 * cifra sale en cero sin que nada falle. Son nombres, no datos de pacientes.
 */
export async function argosNamesText(tx: Db, orgId: string, key: ArgosKey): Promise<string> {
  const [branches, team, services] = await Promise.all([
    listArgosBranches(tx, orgId),
    tx
      .selectDistinct({ name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, orgId))
      .orderBy(asc(user.name)),
    listAgentServices(tx, orgId),
  ])
  const seesStock = argosViewsOf(key).some((view) => view.name === "inventario")
  const products = seesStock
    ? await tx
        .select({ name: product.name })
        .from(product)
        .where(and(eq(product.organizationId, orgId), eq(product.isActive, true)))
        .orderBy(asc(product.name))
    : []
  const lines = [
    "Los nombres de esta clínica, como están en las vistas. En la consulta escríbelos tal cual aunque la pregunta los diga de otra forma («Surco» es la sede que lo lleva, «extracciones» son los servicios de exodoncia, «ortodoncia» es la especialidad que la nombra). Para un tipo de tratamiento, filtra por su especialidad si es toda una, o por los nombres de sus servicios.",
    `- Sedes: ${branches.map((item) => item.name).join(", ") || "ninguna"}.`,
    `- Equipo: ${team.map((item) => item.name).join(", ")}.`,
    services.length ? `- Servicios por especialidad:\n${formatServiceIndex(services).map((line) => `  ${line}`).join("\n")}` : "- Servicios: ninguno.",
    seesStock ? `- Productos: ${products.map((item) => item.name).join(", ") || "ninguno"}.` : "",
  ]
  return lines.filter(Boolean).join("\n")
}

/** Anota la pregunta y devuelve su id: con él se fija, se descarga y se sigue (D2, D5). */
export async function recordArgosQuestion(
  tx: Db,
  orgId: string,
  userId: string,
  input: { outcome: ArgosOutcome; query: string | null; usedModel: boolean; plan?: ArgosStoredPlan | null },
): Promise<string> {
  const [row] = await tx
    .insert(reportQuestion)
    .values({ organizationId: orgId, userId, outcome: input.outcome, query: input.query, usedModel: input.usedModel, plan: input.plan ?? null })
    .returning({ id: reportQuestion.id })
  return row?.id ?? ""
}

/**
 * Lo que muestra Reportes cuando se pregunta desde ahí (decisión D7): su
 * periodo (el mismo valor de la pantalla, que Argos entiende) y su sede valen
 * si la pregunta no dice otros.
 */
export async function argosScreen(tx: Db, orgId: string, screen: ReportQuery, now: Date): Promise<{ period: string; branch: string | null }> {
  const scope = await reportScope(tx, orgId, screen, now)
  return { period: screen.period, branch: scope.branch?.name ?? null }
}

/** Una parte de la frase: lo que vino del resultado va destacado. */
export type ArgosSentencePart = { text: string; strong?: true }

const HOLE = /\{(\w+)\}/g

/** Lo que dice el periodo en la frase (`{periodo}`, `{periodo_antes}`): lo pone odentIA, no el resultado. */
export type ArgosWords = Partial<Record<"periodo" | "periodo_antes", string>>

/** Los huecos de la frase que no son columnas del resultado, `{lista}`/`{filas}` ni el periodo que hay: el modelo se equivocó. */
export function unknownArgosHoles(template: string, result: Pick<ArgosQueryResult, "columns">, words: ArgosWords = {}): string[] {
  const names = new Set(result.columns.map((column) => column.name))
  return [...template.matchAll(HOLE)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "lista" && name !== "filas" && !names.has(name) && !(name in words))
}

/**
 * El periodo ya trae su preposición («del 1 al 21 de octubre», «en setiembre»,
 * «hoy»): si el modelo escribió otra delante («En {periodo}»), sobra y se
 * quita, para que no quede «En del 1 al 21…».
 */
const LEADING_PREPOSITION = /(^|\s)(en|de|durante|desde|para)\s+$/i
const SAID_WITH_PREPOSITION = /^(del|de|en|el|hoy|ayer)\b/

function withoutExtraPreposition(before: string, said: string): string {
  return SAID_WITH_PREPOSITION.test(said) ? before.replace(LEADING_PREPOSITION, "$1") : before
}

/** Al abrir la frase o después de un punto, el periodo va con mayúscula. */
function opening(before: string, said: string): string {
  return before.trim() === "" || /[.!?]\s*$/.test(before) ? said.charAt(0).toLocaleUpperCase() + said.slice(1) : said
}

/** Llena solo el periodo de un texto («Así lo calculé», la frase sin filas). */
export function fillArgosWords(text: string, words: ArgosWords): string {
  let out = ""
  let last = 0
  for (const match of text.matchAll(HOLE)) {
    const name = match[1] ?? ""
    const said = name === "periodo" || name === "periodo_antes" ? words[name] : undefined
    if (said === undefined) continue
    const before = withoutExtraPreposition(out + text.slice(last, match.index ?? 0), said)
    out = before + opening(before, said)
    last = (match.index ?? 0) + match[0].length
  }
  return out + text.slice(last)
}

/**
 * Lo que no se puede leer de una frase: la lista va una sola vez y al final,
 * después de lo que dice qué es («Los que más deben: {lista}.»); en medio de
 * la frase o dos veces, queda entre palabras que ya no se entienden («la mayor
 * fue {lista} y la menor {lista}»). Y un hueco repetido con varias filas dice
 * dos veces la primera («nuevos: 17 %; recurrentes: 17 %»).
 */
export function argosSentenceProblem(template: string, rows = 1): string | null {
  // El periodo no es una fila: puede repetirse.
  const holes = [...template.matchAll(HOLE)].map((match) => match[1] ?? "").filter((name) => name !== "lista" && name !== "filas" && name !== "periodo" && name !== "periodo_antes")
  const repeated = holes.find((name, index) => holes.indexOf(name) !== index)
  if (repeated && rows > 1)
    return `la frase usa {${repeated}} dos veces y siempre es la primera fila: para dos cifras distintas, una sola fila con una columna por cifra`
  const lists = [...template.matchAll(/\{lista\}/g)]
  if (lists.length > 1) return "la frase usa {lista} más de una vez: va una sola vez, al final; para el mayor y el menor usa columnas de una sola fila"
  const list = lists[0]
  if (list && /[\p{L}\p{N}{]/u.test(template.slice((list.index ?? 0) + list[0].length)))
    return "{lista} va al final de la frase, después de dos puntos, sin palabras detrás"
  return null
}

/**
 * Un hueco de la frase que en la primera fila vino sin valor: se leería «—»
 * («el ticket de Surco fue — y el de Miraflores —»). Se le devuelve al modelo
 * solo el nombre de la columna, nunca un dato, para que lo corrija una vez.
 */
export function argosEmptyHoleProblem(template: string, result: Pick<ArgosQueryResult, "columns" | "rows">): string | null {
  const first = result.rows[0]
  if (!first) return null
  const names = new Set(result.columns.map((column) => column.name))
  const empty = [...template.matchAll(HOLE)].map((match) => match[1] ?? "").find((name) => names.has(name) && first[name] === null)
  return empty
    ? `{${empty}} vino sin valor (null) y la frase se leería con un hueco vacío: si es una suma o un conteo, usa coalesce(…, 0); si puede no haber dato (un promedio sin filas, una sede sin nada), di ese caso con palabras en una columna de texto (CASE) y no lo pongas como cifra`
    : null
}

/**
 * Lo que no se muestra en la lista, la tabla ni el CSV: un id (`paciente_id`,
 * `presupuesto_id`…) sirve para contar, agrupar y abrir la página de la persona,
 * y un `total_general…` repite en cada fila el total de todas, que dice la frase.
 */
export function isArgosHiddenColumn(name: string): boolean {
  return /(^|_)id$/.test(name) || /^total_general(_|$)/.test(name)
}

/**
 * Las columnas que la frase ya dice con su hueco y valen lo mismo en todas las
 * filas: son totales («la variación general», «lo cobrado del mes») que en
 * cada fila de la lista o de la tabla solo estorban. Con una sola fila no hay
 * lista que limpiar.
 */
export function argosRepeatedColumns(template: string, result: Pick<ArgosQueryResult, "columns" | "rows">): Set<string> {
  if (result.rows.length < 2) return new Set()
  const holes = new Set([...template.matchAll(HOLE)].map((match) => match[1] ?? ""))
  const first = result.rows[0] ?? {}
  return new Set(result.columns.filter((column) => holes.has(column.name) && result.rows.every((row) => row[column.name] === first[column.name])).map((column) => column.name))
}

/** «cobrado_dinero» → «Cobrado»: el nombre de una columna dicho para la pantalla. */
export function argosColumnLabel(name: string): string {
  const text = name.replace(/_(dinero|pct|mes)$/, "").replace(/_/g, " ").trim()
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : name
}

/**
 * El valor con el formato de la clínica. El nombre de la columna dice qué es:
 * `_dinero` en la moneda de la clínica, `_pct` un porcentaje de 0 a 100 y
 * `_mes` un mes (así se le pide al modelo); el tipo de la base dice si es fecha.
 */
export function formatArgosValue(value: string | number | boolean | null, column: ArgosQueryResult["columns"][number], zone: Pick<OrgLocale, "locale" | "currency" | "timezone">): string {
  if (value === null) return "—"
  if (column.kind === "boolean") return value ? "sí" : "no"
  if (column.kind === "date") {
    const [year, month, day] = String(value).split("-").map(Number)
    const isMonth = /(^|_)mes$/.test(column.name)
    return new Intl.DateTimeFormat(zone.locale, { timeZone: "UTC", ...(isMonth ? {} : { day: "numeric" }), month: "long", year: "numeric" }).format(
      new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)),
    )
  }
  if (column.kind === "timestamp")
    // Un mes que llega como momento (`date_trunc` sobre una fecha con hora) se dice igual que un mes.
    return new Intl.DateTimeFormat(zone.locale, {
      timeZone: zone.timezone,
      ...(/(^|_)mes$/.test(column.name) ? { month: "long", year: "numeric" } : { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    }).format(new Date(String(value)))
  if (column.kind === "number" && typeof value === "number") {
    // Una hora del día (0 a 23) se dice como hora: «14:00», no «14».
    if (/(^|_)hora$/.test(column.name) && Number.isInteger(value) && value >= 0 && value <= 23) return `${String(value).padStart(2, "0")}:00`
    // Una variación lleva su signo: «+1 %» sube, «-32 %» baja.
    if (/^(variacion|cambio|diferencia|crecimiento)/.test(column.name) && /_pct$/.test(column.name) && value > 0)
      return `+${formatArgosValue(value, { ...column, name: "valor_pct" }, zone)}`
    if (/_dinero$/.test(column.name)) return new Intl.NumberFormat(zone.locale, { style: "currency", currency: zone.currency }).format(value)
    if (/_pct$/.test(column.name)) return `${new Intl.NumberFormat(zone.locale, { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} %`
    return new Intl.NumberFormat(zone.locale, { maximumFractionDigits: 2 }).format(value)
  }
  return String(value)
}

/**
 * Llena la frase con el resultado: `{columna}` es el valor de la primera fila,
 * `{lista}` las primeras filas como «a (b, c); …» en el orden de la consulta,
 * con «y N más» si hay más, y `{filas}` cuántas son. Una columna del resultado
 * que se llame `filas` o `lista` gana sobre el hueco: es lo que el modelo
 * contó. Si la consulta se cortó (el tope o su propio LIMIT), la lista dice
 * «y más»: no se sabe cuántas faltan. En la lista, un número
 * suelto lleva el nombre de su columna («Dra. Ana Torres (citas: 65)»): el
 * dinero y los porcentajes solos ya se entienden. Un hueco desconocido queda
 * «—» (antes se reintenta). El «%» que el modelo escriba junto a un
 * porcentaje se quita: el hueco ya lo trae.
 */
export function fillArgosSentence(
  template: string,
  result: ArgosQueryResult,
  zone: Pick<OrgLocale, "locale" | "currency" | "timezone">,
  words: ArgosWords = {},
): { text: string; parts: ArgosSentencePart[] } {
  const first = result.rows[0] ?? {}
  const byName = new Map(result.columns.map((column) => [column.name, column]))
  const cell = (row: Record<string, string | number | boolean | null>, name: string) => {
    const column = byName.get(name)
    return column ? formatArgosValue(row[name] ?? null, column, zone) : "—"
  }
  const repeated = argosRepeatedColumns(template, result)
  const [lead, ...rest] = result.columns.filter((column) => !isArgosHiddenColumn(column.name) && !repeated.has(column.name))
  // El dinero y el porcentaje solos se entienden; dos de lo mismo en una fila llevan su nombre («cobrado: S/ 284,045.00, dejo: S/ 15,946.50»).
  const unitOf = (name: string) => /_(dinero|pct)$/.exec(name)?.[1] ?? null
  const twice = (unit: string | null) => unit !== null && rest.filter((other) => unitOf(other.name) === unit).length > 1
  const selfExplained = (column: ArgosQueryResult["columns"][number]) => column.kind !== "number" || (unitOf(column.name) !== null && !twice(unitOf(column.name)))
  const labeled = !(rest.length === 1 && rest[0] && selfExplained(rest[0]))
  const items = result.rows.slice(0, ARGOS_LIST_ROWS).map((row) => {
    const head = lead ? cell(row, lead.name) : ""
    if (!rest.length) return head
    const details = rest.map((column) => (labeled && !selfExplained(column) ? `${argosColumnLabel(column.name).toLowerCase()}: ${cell(row, column.name)}` : cell(row, column.name)))
    return `${head} (${details.join(", ")})`
  })
  const more = result.truncated ? " y más" : result.rows.length > ARGOS_LIST_ROWS ? ` y ${result.rows.length - ARGOS_LIST_ROWS} más` : ""
  const list = `${items.join("; ")}${more}`
  const rows = result.truncated ? `más de ${result.rows.length}` : String(result.rows.length)
  const parts: ArgosSentencePart[] = []
  let last = 0
  for (const match of template.matchAll(HOLE)) {
    const name = match[1] ?? ""
    const at = match.index ?? 0
    if (at > last) parts.push({ text: template.slice(last, at) })
    // El periodo lo dice odentIA, no es una cifra: va sin destacar, sin una preposición de más delante y, al abrir la frase, con mayúscula.
    const said = !byName.has(name) && (name === "periodo" || name === "periodo_antes") ? words[name] : undefined
    if (said !== undefined) {
      const previous = parts.at(-1)
      if (previous && !previous.strong) previous.text = withoutExtraPreposition(previous.text, said)
      if (previous && !previous.strong && !previous.text) parts.pop()
      const before = parts.map((part) => part.text).join("")
      parts.push({ text: opening(before, said) })
      last = at + match[0].length
      continue
    }
    parts.push({ text: byName.has(name) ? cell(first, name) : name === "lista" ? list : name === "filas" ? rows : "—", strong: true })
    last = at + match[0].length
    if (/_pct$/.test(name)) {
      const repeated = /^\s?%/.exec(template.slice(last))
      if (repeated) last += repeated[0].length
    }
  }
  if (last < template.length) parts.push({ text: template.slice(last) })
  return { text: parts.map((part) => part.text).join(""), parts }
}
