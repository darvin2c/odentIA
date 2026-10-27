import type { Db } from "@odentia/db"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import {
  advanceDemo,
  buildDemo,
  claimPendingDemo,
  deleteDemo,
  type DemoRecipeRef,
  demosToAdvance,
  expiredDemos,
  failStaleDemos,
  purgeDemoOrganization,
} from "@odentia/services"
import type { ClinicalProduct } from "@odentia/clinical"
import { eq, sql } from "drizzle-orm"

/**
 * Las demos para presentar en el worker (ADR 0096). Armar una lleva minutos:
 * corre aparte, de a una, sin frenar las colas (el lazo sigue mientras
 * tanto). La fila late cada 30 s; si el worker se reinicia a medias, la demo
 * queda fallida con «Intentar de nuevo» y nada a medias en la base (todo va en
 * una transacción). Cada día de su zona se pone al día, y la que nadie abrió en
 * 60 días se borra sola.
 */
export interface DemosDeps {
  ownerDb: Db
  secretsKey: Buffer
  fetch: typeof fetch
  /** Quita del almacenamiento lo que tenía la clínica borrada. */
  deleteObject?: (key: string) => Promise<void>
}

let building: Promise<void> | null = null

function refOf(row: typeof saasDemo.$inferSelect): DemoRecipeRef {
  return {
    id: row.id,
    product: row.product as ClinicalProduct,
    kind: row.kind,
    size: row.size as DemoRecipeRef["size"],
    months: row.months,
    countryCode: row.countryCode,
    name: row.name,
    slug: row.slug,
    presenterUserId: row.presenterUserId,
    seed: row.seed,
  }
}

async function build(deps: DemosDeps, row: typeof saasDemo.$inferSelect): Promise<void> {
  const beat = setInterval(() => {
    void deps.ownerDb
      .update(saasDemo)
      .set({ heartbeatAt: new Date() })
      .where(eq(saasDemo.id, row.id))
      .catch(() => undefined)
  }, 30_000)
  try {
    const storageKeys: string[] = []
    const built = await deps.ownerDb.transaction(async (tx) => {
      // Volver a empezar: la clínica anterior se va en la misma transacción.
      if (row.organizationId)
        storageKeys.push(
          ...(await purgeDemoOrganization(tx as Db, row.id, row.organizationId)).storageKeys,
        )
      const result = await buildDemo(tx as Db, refOf(row), {
        // Volver a empezar conserva la clínica: su ficha, sus enlaces y las sesiones siguen.
        ...(row.organizationId ? { organizationId: row.organizationId } : {}),
        secretsKey: deps.secretsKey,
        fetch: deps.fetch,
        // El avance va por otra conexión: la transacción no se ve hasta el final.
        onProgress: async (progress) => {
          await deps.ownerDb
            .update(saasDemo)
            .set({ progress, heartbeatAt: new Date() })
            .where(eq(saasDemo.id, row.id))
        },
      })
      const now = new Date()
      const saved = await tx
        .update(saasDemo)
        .set({
          organizationId: result.organizationId,
          slug: result.slug,
          status: "lista",
          error: null,
          historyThrough: result.historyThrough,
          advancedOn: null,
          readyAt: now,
          progress: { step: "listo", done: 5, total: 5 },
          updatedAt: now,
        })
        .where(eq(saasDemo.id, row.id))
        .returning({ id: saasDemo.id })
      // Sin su fila sería una clínica inventada que nada puede borrar: no se guarda.
      if (saved.length === 0) throw new Error("La demo se borró mientras se armaba")
      return result
    })
    for (const key of storageKeys) await deps.deleteObject?.(key).catch(() => undefined)
    console.log(`worker: demo ${row.slug} lista (${built.organizationId})`)
  } catch (error) {
    console.error(`worker: la demo ${row.slug} no se pudo armar`, error)
    await deps.ownerDb
      .update(saasDemo)
      .set({
        status: "fallida",
        error: error instanceof Error ? error.message.slice(0, 300) : "Error al armarla",
        updatedAt: new Date(),
      })
      .where(eq(saasDemo.id, row.id))
  } finally {
    clearInterval(beat)
  }
}

/** Una vuelta: arma la que espera, pone al día una y borra las vencidas. */
export async function runDemosTick(
  deps: DemosDeps,
): Promise<{ started: boolean; advanced: number; expired: number }> {
  let started = false
  if (!building) {
    await deps.ownerDb.transaction((tx) => failStaleDemos(tx as Db))
    const row = await deps.ownerDb.transaction((tx) => claimPendingDemo(tx as Db))
    if (row) {
      started = true
      building = build(deps, row).finally(() => {
        building = null
      })
    }
  }
  let advanced = 0
  // Mientras se arma otra, la noche espera: una transacción larga a la vez.
  if (!building) {
    for (const row of await deps.ownerDb.transaction((tx) => demosToAdvance(tx as Db))) {
      if (!row.organizationId) continue
      try {
        await deps.ownerDb.transaction(async (tx) => {
          const result = await advanceDemo(tx as Db, {
            ...refOf(row),
            organizationId: row.organizationId as string,
            historyThrough: row.historyThrough,
          })
          await tx
            .update(saasDemo)
            .set({
              historyThrough: result.historyThrough,
              advancedOn: result.today,
              updatedAt: new Date(),
            })
            .where(eq(saasDemo.id, row.id))
        })
        advanced += 1
      } catch (error) {
        console.error(`worker: la demo ${row.slug} no se pudo poner al día`, error)
        // Se vuelve a intentar mañana: una que falla no deja a las demás sin ponerse al día.
        await deps.ownerDb
          .execute(sql`update admin.saas_demo d set advanced_on = (now() at time zone p.timezone)::date
            from org_profile p where p.organization_id = d.organization_id and d.id = ${row.id}`)
          .catch(() => undefined)
      }
    }
  }
  let expired = 0
  if (!building) {
    for (const view of await deps.ownerDb.transaction((tx) => expiredDemos(tx as Db))) {
      try {
        const purged = await deps.ownerDb.transaction((tx) =>
          deleteDemo(tx as Db, null, view.id, null),
        )
        for (const key of purged.storageKeys) await deps.deleteObject?.(key).catch(() => undefined)
        expired += 1
      } catch (error) {
        console.error(`worker: la demo ${view.slug} no se pudo borrar`, error)
      }
    }
  }
  return { started, advanced, expired }
}

/** Para las pruebas: espera a que termine la que se está armando. */
export async function waitForDemoBuild(): Promise<void> {
  await building
}
