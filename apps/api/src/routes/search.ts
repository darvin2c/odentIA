import { meterAiUse } from "@odentia/agent"
import { withOrgContext } from "@odentia/db"
import {
  type ClinicalAccessResource,
  rankByMeaning,
  recordClinicalAccess,
  SEARCH_TYPES,
  type SearchEmbedder,
  type SearchOwner,
  type SearchType,
  searchDigits,
  searchEverything,
  searchMeaningOwners,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/**
 * Buscador rápido (Ctrl+K; ADR 0066): una sola búsqueda en casi todo lo de la
 * clínica, cada resultado debajo de su dueño. Cada tipo pide su propio permiso
 * dentro del servicio: la ruta solo exige sesión en la clínica.
 *
 * Significado (fase 3): servicios, promociones y respuestas también se buscan
 * por lo que se quiso decir con los vectores del agente (ADR 0021). Primero se
 * busca por letras; la frase va al proveedor solo si no trajo a ninguna persona
 * ni nada de la historia (un nombre o un texto clínico nunca sale) y si quien
 * busca puede ver servicios o respuestas. Se espera como mucho `MEANING_WAIT_MS`
 * y, si no llega, quedan los resultados por letras. La misma frase se recuerda
 * unos minutos para no pagarla dos veces.
 */
const MEANING_WAIT_MS = 800
const MEANING_CACHE_MS = 5 * 60_000
const MEANING_CACHE_MAX = 500

const searchQuery = z.object({
  q: z.string().trim().min(2).max(200),
  tipos: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",").filter(Boolean) : undefined))
    .pipe(z.array(z.enum(SEARCH_TYPES)).optional()),
})

export interface SearchDeps extends CrmDeps {
  embedder?: SearchEmbedder
}

const meaningCache = new Map<string, { at: number; embedding: number[] }>()

async function queryEmbedding(
  deps: SearchDeps,
  orgId: string,
  embedder: SearchEmbedder,
  q: string,
): Promise<number[] | undefined> {
  const key = `${embedder.model}\u0000${q.toLocaleLowerCase("es")}`
  const cached = meaningCache.get(key)
  if (cached && Date.now() - cached.at < MEANING_CACHE_MS) return cached.embedding
  const [embedding] = await meterAiUse(deps.db, orgId, "vectores", () => embedder.embed([q]))
  if (!embedding?.length) return undefined
  if (meaningCache.size >= MEANING_CACHE_MAX)
    meaningCache.delete(meaningCache.keys().next().value as string)
  meaningCache.set(key, { at: Date.now(), embedding })
  return embedding
}

/** Lo que el significado ordena, o nada si no hay vectores o no llegan a tiempo. */
async function meaningOf(deps: SearchDeps, orgId: string, embedder: SearchEmbedder, q: string) {
  try {
    const embedding = await Promise.race([
      queryEmbedding(deps, orgId, embedder, q),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), MEANING_WAIT_MS)),
    ])
    if (!embedding) return undefined
    return await withOrgContext(deps.db, orgId, (tx) =>
      rankByMeaning(tx, orgId, { model: embedder.model, embedding }),
    )
  } catch {
    return undefined
  }
}

export function createSearchRoute(deps: SearchDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = searchQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { q, tipos } = parsed.data
    const types = tipos as SearchType[] | undefined
    const can = (permission: string) =>
      canAccess(memberRole, permission as Parameters<typeof canAccess>[1])
    let reads: Array<{ patientId: string; resource: ClinicalAccessResource }> = []
    const response = await runService(c, 200, async () => {
      const found = await withOrgContext(deps.db, orgId, (tx) =>
        searchEverything(tx, orgId, { q, can, viewer: { userId, role: memberRole }, types }),
      )
      reads = found.clinicalReads
      let meaning: SearchOwner[] = []
      const embedder = deps.embedder
      const wantsMeaning =
        !!embedder &&
        !found.personal &&
        !searchDigits(q) &&
        q.length >= 4 &&
        (can("catalog.read") || can("conversations.read")) &&
        (!types || types.includes("servicio") || types.includes("respuesta"))
      if (embedder && wantsMeaning) {
        const ranked = await meaningOf(deps, orgId, embedder, q)
        if (ranked)
          meaning = await withOrgContext(deps.db, orgId, (tx) =>
            searchMeaningOwners(tx, orgId, {
              can,
              types,
              ranked: {
                services: ranked.services,
                promotions: ranked.promotions,
                answers: ranked.answers,
              },
              exclude: new Set(found.owners.map((owner) => owner.key)),
            }),
          )
      }
      return { owners: found.owners, meaning }
    })
    // Lo clínico que se mostró queda en el registro de accesos, como si se abriera
    // la ficha: todo en una transacción y solo si la búsqueda respondió bien.
    if (response.status === 200 && reads.length) {
      try {
        await withOrgContext(deps.db, orgId, async (tx) => {
          for (const read of reads)
            await recordClinicalAccess(tx, orgId, userId, read.patientId, read.resource)
        })
      } catch (error) {
        console.error("No se pudo registrar la consulta a la historia clínica desde el buscador", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return response
  })

  return app
}
