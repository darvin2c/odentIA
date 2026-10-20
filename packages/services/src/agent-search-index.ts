import { type Db, withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { agentSearchItem, type SearchItemKind } from "@odentia/db/schema/agent"
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm"
import type { TreatmentKind } from "@odentia/clinical"
import { listAgentPromotions, listAgentProfessionals, listAgentServices } from "./agent-clinic-info.js"
import { listActiveKnowledge } from "./knowledge.js"

/**
 * Índice de la búsqueda por significado (ADR 0021). Cada cosa de la clínica
 * que el agente puede encontrar tiene una fila con su texto descriptivo y su
 * vector. Solo sirve para encontrar: precio, vigencia y condiciones se leen de
 * su tabla al responder. El texto nunca lleva precios, fechas ni datos de una
 * persona; solo nombres, especialidades, condiciones y respuestas oficiales.
 *
 * Conciliar (`syncSearchItems`) es solo base de datos; vectorizar es una
 * llamada externa y va fuera de toda transacción (`refreshAgentSearch`).
 */

/** Quien convierte textos en vectores. `model` identifica el espacio: solo se comparan vectores del mismo. */
export interface SearchEmbedder {
  model: string
  embed(texts: string[]): Promise<number[][]>
}

/** Tope del texto de una respuesta oficial en el índice: el arranque basta para reconocer el tema. */
const ANSWER_CHARS = 600
/** Cuántas filas se vectorizan por llamada al proveedor. */
const EMBED_BATCH = 64
/**
 * Distancia coseno máxima para contar como «encontrado». Por encima, la
 * coincidencia es tan lejana que confunde más de lo que ayuda.
 */
export const SEARCH_MAX_DISTANCE = 0.65

/**
 * Palabras con que la gente nombra cada tipo de tratamiento. Solo van al
 * índice, para que «matar el nervio» encuentre una endodoncia; el agente nunca
 * las dice como dato. Van con el tipo del servicio (ADR 0069), que no cambia
 * aunque la clínica renombre su especialidad.
 */
const KIND_WORDS: Record<TreatmentKind, string> = {
  diagnostico: "revisión, chequeo, evaluación, radiografía",
  prevencion: "limpieza, prevenir caries, flúor",
  restauradora: "curación de caries, empaste, resina",
  endodoncia: "tratamiento de conducto, matar el nervio, dolor de muela",
  periodoncia: "encías que sangran, sarro, piorrea",
  cirugia: "sacar una muela o un diente, extracción",
  protesis: "dientes postizos, dentadura, corona, funda",
  implantologia: "reemplazar un diente perdido, diente fijo",
  ortodoncia: "brackets, frenillos, alinear los dientes",
  odontopediatria: "niños, dientes de leche",
  estetica: "apariencia de la sonrisa, dientes más blancos o parejos",
  disfuncion: "mandíbula, bruxismo, rechinar los dientes",
  anestesia: "sedación",
  general: "atención dental",
}

/** Qué es cada cosa, dicho en el texto del índice: así «¿tienen alguna promo?» encuentra las promociones. */
function serviceText(name: string, specialty: string | null, kind: TreatmentKind | null): string {
  const words = kind ? KIND_WORDS[kind] : undefined
  return `Servicio de la clínica: ${name}.${specialty ? ` Especialidad: ${specialty}.` : ""}${words ? ` Para: ${words}.` : ""}`
}

interface WantedItem {
  kind: SearchItemKind
  refId: string
  text: string
}

/** Lo que hoy debería estar en el índice de una clínica. */
export async function wantedSearchItems(tx: Db, orgId: string): Promise<WantedItem[]> {
  const services = await listAgentServices(tx, orgId)
  const promotions = await listAgentPromotions(tx, orgId)
  const professionals = await listAgentProfessionals(tx, orgId)
  const answers = await listActiveKnowledge(tx, orgId)
  return [
    ...services.map((s) => ({ kind: "servicio" as const, refId: s.id, text: serviceText(s.name, s.specialty, s.kind) })),
    ...promotions.map((p) => ({
      kind: "promocion" as const,
      refId: p.id,
      text: [
        `Promoción, oferta o descuento: ${p.name}`,
        `Incluye ${p.items.map((item) => item.serviceName).join(", ")}`,
        p.conditions ? `Condiciones: ${p.conditions}` : null,
      ]
        .filter(Boolean)
        .join(". "),
    })),
    ...professionals.map((p) => ({
      kind: "profesional" as const,
      refId: p.id,
      text: `Profesional de la clínica, odontólogo: ${p.name}.${p.specialties.length ? ` Especialista en ${p.specialties.join(", ")}.` : ""}`,
    })),
    ...answers.map((a) => ({
      kind: "respuesta" as const,
      refId: a.id,
      text: [`Información de la clínica: ${a.title}`, ...a.askForms, a.body.slice(0, ANSWER_CHARS)].join(". "),
    })),
  ]
}

/**
 * Deja el índice igual a lo que la clínica tiene hoy: agrega lo nuevo, borra el
 * vector de lo que cambió de texto y quita lo que ya no existe. Devuelve
 * cuántas filas esperan su vector.
 */
export async function syncSearchItems(tx: Db, orgId: string): Promise<number> {
  const wanted = await wantedSearchItems(tx, orgId)
  const current = await tx
    .select({ id: agentSearchItem.id, kind: agentSearchItem.kind, refId: agentSearchItem.refId, text: agentSearchItem.text })
    .from(agentSearchItem)
    .where(eq(agentSearchItem.organizationId, orgId))
  const key = (kind: string, refId: string) => `${kind}:${refId}`
  const byKey = new Map(current.map((row) => [key(row.kind, row.refId), row]))
  const wantedKeys = new Set(wanted.map((item) => key(item.kind, item.refId)))
  for (const item of wanted) {
    const row = byKey.get(key(item.kind, item.refId))
    if (!row) {
      await tx.insert(agentSearchItem).values({ organizationId: orgId, kind: item.kind, refId: item.refId, text: item.text })
    } else if (row.text !== item.text) {
      await tx
        .update(agentSearchItem)
        .set({ text: item.text, model: null, embedding: null, updatedAt: new Date() })
        .where(eq(agentSearchItem.id, row.id))
    }
  }
  const gone = current.filter((row) => !wantedKeys.has(key(row.kind, row.refId))).map((row) => row.id)
  if (gone.length) await tx.delete(agentSearchItem).where(inArray(agentSearchItem.id, gone))
  const [pending] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(agentSearchItem)
    .where(and(eq(agentSearchItem.organizationId, orgId), isNull(agentSearchItem.embedding)))
  return pending?.total ?? 0
}

/** Filas sin vector, o con el de otro modelo, para vectorizar. */
export async function pendingSearchItems(
  tx: Db,
  orgId: string,
  model: string,
  limit = EMBED_BATCH,
): Promise<Array<{ id: string; text: string }>> {
  return tx
    .select({ id: agentSearchItem.id, text: agentSearchItem.text })
    .from(agentSearchItem)
    .where(
      and(
        eq(agentSearchItem.organizationId, orgId),
        or(isNull(agentSearchItem.embedding), isNull(agentSearchItem.model), ne(agentSearchItem.model, model)),
      ),
    )
    .orderBy(asc(agentSearchItem.updatedAt))
    .limit(limit)
}

/** Guarda los vectores calculados, solo si el texto no cambió mientras tanto. */
export async function storeSearchEmbeddings(
  tx: Db,
  orgId: string,
  model: string,
  items: Array<{ id: string; text: string; embedding: number[] }>,
): Promise<void> {
  for (const item of items) {
    await tx
      .update(agentSearchItem)
      .set({ model, embedding: item.embedding, updatedAt: new Date() })
      .where(
        and(
          eq(agentSearchItem.organizationId, orgId),
          eq(agentSearchItem.id, item.id),
          eq(agentSearchItem.text, item.text),
        ),
      )
  }
}

export interface MeaningRank {
  services: string[]
  promotions: string[]
  professionals: string[]
  answers: string[]
}

/**
 * Lo más parecido a una pregunta, por tipo y en orden. Recibe el vector ya
 * calculado (la llamada externa va fuera de la transacción) y devuelve solo
 * identificadores: los datos se leen después de su tabla.
 */
export async function rankByMeaning(
  tx: Db,
  orgId: string,
  query: { model: string; embedding: number[] },
  limit = 8,
  maxDistance = SEARCH_MAX_DISTANCE,
): Promise<MeaningRank> {
  const vector = `[${query.embedding.join(",")}]`
  const rows = (await tx.execute(sql`
    select kind, ref_id, distance from (
      select kind, ref_id, embedding <=> ${vector}::vector as distance,
             row_number() over (partition by kind order by embedding <=> ${vector}::vector) as position
      from agent_search_item
      where organization_id = ${orgId} and model = ${query.model} and embedding is not null
    ) ranked
    where position <= ${limit} and distance <= ${maxDistance}
    order by kind, distance`)) as unknown as Array<{ kind: SearchItemKind; ref_id: string }>
  const of = (kind: SearchItemKind) => rows.filter((row) => row.kind === kind).map((row) => row.ref_id)
  return { services: of("servicio"), promotions: of("promocion"), professionals: of("profesional"), answers: of("respuesta") }
}

/**
 * El trabajo del trabajador en segundo plano: concilia el índice de cada
 * clínica y vectoriza lo que falta, en lotes. Un fallo del proveedor deja las
 * filas sin vector: la búsqueda por palabras sigue funcionando y se reintenta
 * en el siguiente ciclo.
 */
export async function refreshAgentSearch(
  ownerDb: Db,
  appDb: Db,
  embedder: SearchEmbedder,
  options: {
    maxBatchesPerOrg?: number
    /** Envuelve cada llamada al proveedor de una clínica: así queda su uso con origen `vectores`. */
    meter?: <T>(orgId: string, run: () => Promise<T>) => Promise<T>
  } = {},
): Promise<{ orgs: number; embedded: number; failed: number }> {
  const meter = options.meter ?? (<T>(_orgId: string, run: () => Promise<T>) => run())
  const orgs = await ownerDb.select({ id: organization.id }).from(organization)
  let embedded = 0
  let failed = 0
  for (const org of orgs) {
    // Lo que falla en una clínica no deja sin conciliar a las demás.
    let pending: number
    try {
      pending = await withOrgContext(appDb, org.id, (tx) => syncSearchItems(tx, org.id))
    } catch {
      failed += 1
      continue
    }
    if (pending === 0 && !(await hasOtherModel(appDb, org.id, embedder.model))) continue
    for (let batch = 0; batch < (options.maxBatchesPerOrg ?? 4); batch++) {
      const items = await withOrgContext(appDb, org.id, (tx) => pendingSearchItems(tx, org.id, embedder.model))
      if (!items.length) break
      let vectors: number[][]
      try {
        vectors = await meter(org.id, () => embedder.embed(items.map((item) => item.text)))
      } catch {
        failed += items.length
        break
      }
      if (vectors.length !== items.length) {
        failed += items.length
        break
      }
      try {
        await withOrgContext(appDb, org.id, (tx) =>
          storeSearchEmbeddings(
            tx,
            org.id,
            embedder.model,
            items.map((item, index) => ({ ...item, embedding: vectors[index] ?? [] })),
          ),
        )
      } catch {
        failed += items.length
        break
      }
      embedded += items.length
    }
  }
  return { orgs: orgs.length, embedded, failed }
}

async function hasOtherModel(appDb: Db, orgId: string, model: string): Promise<boolean> {
  const rows = await withOrgContext(appDb, orgId, (tx) =>
    tx
      .select({ id: agentSearchItem.id })
      .from(agentSearchItem)
      .where(and(eq(agentSearchItem.organizationId, orgId), ne(agentSearchItem.model, model)))
      .limit(1),
  )
  return rows.length > 0
}
