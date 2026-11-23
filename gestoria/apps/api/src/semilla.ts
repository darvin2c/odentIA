import {
  accountCopy,
  createOwnerDb,
  type Db,
  store,
  storeEvent,
  storeInvitation,
  storeMember,
} from "@gestoria/db"
import type { AccountState } from "@odentia/contract"
import { and, eq, isNull } from "drizzle-orm"
import { saveState } from "./acuerdo.js"
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
        country: "PE",
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
    await seedDemoPlan(tx as unknown as Db, DEMO_STORE_ID)
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

/**
 * «Plan y pagos» de ejemplo (B7): lo que respondería la administración, como si ya hubiera
 * preguntado (en desarrollo, sin `GESTORIA_CONTRACT_SECRET`, no se pregunta y queda esto). Un mes
 * pagado, el actual por pagar, un aviso del tope y una pregunta respondida.
 */
async function seedDemoPlan(tx: Db, storeId: string): Promise<void> {
  const day = 86_400_000
  const now = Date.now()
  const at = (days: number) => new Date(now + days * day).toISOString()
  const state: AccountState = {
    account: storeId,
    found: true,
    at: at(0),
    access: {
      allowed: true,
      status: "activa",
      reason: null,
      readOnlyAt: null,
      trialEndsAt: null,
    },
    agents: { trialExhausted: false, capReached: false },
    budget: {
      currency: "USD",
      creditCents: 500,
      creditUsedCents: 500,
      capCents: 3000,
      spentCents: 2460,
      periodStart: at(-20),
      periodEnd: at(10),
    },
    plan: {
      code: "gestoria-tienda",
      name: "Tienda",
      currency: "USD",
      priceCents: 1900,
      creditCents: 500,
    },
    charges: [
      {
        id: "semilla-cargo-2",
        periodStart: at(-50),
        periodEnd: at(-20),
        amountCents: 3140,
        paidCents: 0,
        currency: "USD",
        status: "pendiente",
        dueAt: at(5),
        lines: [
          { kind: "plan", description: "Plan Tienda", quantity: 1, amountCents: 1900 },
          {
            kind: "conversacion",
            description: "Informa: atendió una conversación",
            quantity: 62,
            amountCents: 620,
          },
          {
            kind: "conversacion",
            description: "Gestiona: atendió una conversación y tomó un pedido",
            quantity: 31,
            amountCents: 620,
          },
        ],
      },
      {
        id: "semilla-cargo-1",
        periodStart: at(-80),
        periodEnd: at(-50),
        amountCents: 2380,
        paidCents: 2380,
        currency: "USD",
        status: "pagada",
        dueAt: at(-45),
        lines: [
          { kind: "plan", description: "Plan Tienda", quantity: 1, amountCents: 1900 },
          {
            kind: "conversacion",
            description: "Informa: atendió una conversación",
            quantity: 48,
            amountCents: 480,
          },
        ],
      },
    ],
    payments: [
      {
        id: "semilla-pago-1",
        chargeId: "semilla-cargo-1",
        amountCents: 2380,
        currency: "USD",
        status: "confirmado",
        at: at(-46),
      },
    ],
    notices: [{ key: "tope:aviso:demo", family: "tope", level: "aviso", action: "cambiar_tope" }],
    paymentMethods: [
      {
        code: "yape",
        name: "Yape",
        instructions: "Yapea a Sallca Group al 999 888 777 y sube la captura.",
      },
      {
        code: "transferencia",
        name: "Transferencia BCP",
        instructions: "Cuenta en dólares 193-0000000-1-00 a nombre de Sallca Group E.I.R.L.",
      },
    ],
    support: [
      {
        id: "semilla-soporte-1",
        status: "esperando_clinica",
        question: "¿Puedo pagar con Yape?",
        createdAt: at(-3),
        replies: [
          {
            body: "Sí: al pagar el cobro de este mes, elige Yape y sube la captura.",
            at: at(-2),
          },
        ],
      },
    ],
  }
  await saveState(tx, storeId, state, new Date(now))
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
