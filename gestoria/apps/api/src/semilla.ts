import {
  accountCopy,
  createOwnerDb,
  type Db,
  store,
  storeEvent,
  storeInvitation,
  storeMember,
} from "@gestoria/db"
import { and, eq, isNull } from "drizzle-orm"
import { seedDemoConfiguration } from "./semilla-catalogo.js"
import { seedDemoOrders } from "./semilla-pedidos.js"
import { seedDemoSofi } from "./semilla-sofi.js"

/**
 * La tienda de ejemplo de gestorIA, Calzados Rosa (lienzo B, tablero 2), para desarrollo y
 * demostraciones: nunca corre en producción ni en las pruebas. Cada entrega de gestorIA le suma
 * lo suyo (B2 sus conversaciones, B3 su configuración y su catálogo en `semilla-catalogo.ts`,
 * B4 sus pedidos, B5 Sofi y Argos en `semilla-sofi.ts`).
 *
 * Las personas del equipo son copias de cuentas de ejemplo: no existen en la cuenta, así que no
 * se puede entrar con ellas. Para entrar a la tienda, `GESTORIA_SEMILLA_CORREO` deja una
 * invitación de Dueño para ese correo: se acepta entrando con la cuenta de ese correo.
 */
export const DEMO_STORE_ID = "6a1d6b52-6f73-4a5c-9b3a-5c0a1d0e2401"

const TEAM = [
  {
    userId: "semilla-rosa",
    name: "Rosa Quispe",
    email: "rosa@calzadosrosa.demo",
    role: "owner" as const,
  },
  {
    userId: "semilla-mario",
    name: "Mario Huamán",
    email: "mario@calzadosrosa.demo",
    role: "admin" as const,
  },
  {
    userId: "semilla-lucia",
    name: "Lucía Torres",
    email: "lucia@calzadosrosa.demo",
    role: "sales" as const,
  },
]

export async function seedDemoStore(ownerDb: Db, invite?: string): Promise<void> {
  await ownerDb.transaction(async (tx) => {
    await tx
      .insert(accountCopy)
      .values(TEAM.map(({ userId, name, email }) => ({ userId, name, email })))
      .onConflictDoNothing()
    const [created] = await tx
      .insert(store)
      .values({
        id: DEMO_STORE_ID,
        name: "Calzados Rosa",
        currency: "PEN",
        createdBy: "semilla-rosa",
      })
      .onConflictDoNothing()
      .returning({ id: store.id })
    if (created) {
      await tx.insert(storeMember).values(
        TEAM.map(({ userId, role }) => ({
          storeId: DEMO_STORE_ID,
          userId,
          role,
          addedBy: role === "owner" ? null : "semilla-rosa",
        })),
      )
      await tx
        .insert(storeEvent)
        .values({ storeId: DEMO_STORE_ID, actorUserId: "semilla-rosa", action: "tienda.creada" })
      // Una invitación pendiente, como la de cualquier tienda que está armando su equipo.
      await tx.insert(storeInvitation).values({
        storeId: DEMO_STORE_ID,
        email: "carla.ventas@calzadosrosa.demo",
        role: "sales",
        invitedBy: "semilla-rosa",
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
    }
    await seedDemoConfiguration(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoOrders(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoSofi(tx as unknown as Db, DEMO_STORE_ID)
    const email = invite?.trim().toLowerCase()
    if (email) {
      const [pending] = await tx
        .select({ id: storeInvitation.id })
        .from(storeInvitation)
        .where(
          and(
            eq(storeInvitation.storeId, DEMO_STORE_ID),
            eq(storeInvitation.email, email),
            isNull(storeInvitation.acceptedAt),
            isNull(storeInvitation.revokedAt),
          ),
        )
      if (!pending)
        await tx.insert(storeInvitation).values({
          storeId: DEMO_STORE_ID,
          email,
          role: "owner",
          invitedBy: "semilla-rosa",
          expiresAt: new Date(Date.now() + 30 * 86_400_000),
        })
    }
  })
}

const isMain = process.argv[1]?.endsWith("semilla.ts")
if (isMain) {
  const url = process.env.GESTORIA_DATABASE_URL
  if (!url)
    throw new Error("GESTORIA_DATABASE_URL es obligatoria para sembrar la tienda de ejemplo")
  const db = createOwnerDb(url, { max: 1 })
  await seedDemoStore(db, process.env.GESTORIA_SEMILLA_CORREO)
  console.log("gestoria: Calzados Rosa lista")
  process.exit(0)
}
