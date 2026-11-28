import {
  accountCopy,
  createAppDb,
  createOwnerDb,
  type Db,
  store,
  storeEvent,
  storeInvitation,
  storeMember,
  storeSupportAccess,
} from "@gestoria/db"
import type { AccountState } from "@odentia/contract"
import { and, eq, isNull } from "drizzle-orm"
import { saveState } from "./acuerdo.js"
import { seedDemoPushChoices } from "./semilla-avisos.js"
import { seedDemoExchanges } from "./semilla-cambios.js"
import { seedDemoConfiguration } from "./semilla-catalogo.js"
import { seedDemoCustomers } from "./semilla-clientes.js"
import { seedDemoDispatch } from "./semilla-despachos.js"
import { recomputeStoreIn } from "./clientas-grupos.js"
import { seedDemoSegments } from "./semilla-grupos.js"
import { profileStore } from "./sofi/perfilar.js"
import { seedDemoBrand } from "./semilla-marca.js"
import { seedDemoCorrections, seedDemoOrders, seedDemoPartPayment } from "./semilla-pedidos.js"
import { seedDemoProfiles } from "./semilla-perfil.js"
import {
  DEMO_NEW_STORE_ID,
  DEMO_NEW_STORE_OWNER,
  seedDemoNewStore,
  seedDemoSetupDone,
} from "./semilla-primeros-pasos.js"
import { seedDemoSofi } from "./semilla-sofi.js"
import { receiveSupportRequest } from "./soporte.js"

/**
 * La tienda de ejemplo de gestorIA, Calzados Rosa (lienzo B, tablero 2), para desarrollo y
 * demostraciones: nunca corre en producción ni en las pruebas. Cada entrega de gestorIA le suma
 * lo suyo (B2 sus conversaciones, B3 su configuración y su catálogo en `semilla-catalogo.ts`,
 * B4 sus pedidos, B5 Sofi y Argos en `semilla-sofi.ts`, Clientes en `semilla-clientes.ts` y
 * «Tu marca» en `semilla-marca.ts`, lo que cada persona elige recibir en el celular en
 * `semilla-avisos.ts` y los grupos de las clientas en `semilla-grupos.ts`). Inicio muestra su
 * «Te toca» con eso mismo; para sus primeros pasos, la demo suma una tienda que recién empieza, Tortas Carmen (`semilla-primeros-pasos.ts`).
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
    await seedDemoBrand(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoOrders(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoPartPayment(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoCorrections(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoSofi(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoCustomers(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoExchanges(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoPushChoices(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoDispatch(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoSetupDone(tx as unknown as Db, DEMO_STORE_ID)
    await seedDemoNewStore(tx as unknown as Db)
    // Quien va a usar la demo, si ya entró alguna vez a gestorIA (su copia de la cuenta).
    const email = invite?.trim().toLowerCase()
    const [guest] = email
      ? await tx
          .select({ userId: accountCopy.userId })
          .from(accountCopy)
          .where(eq(accountCopy.email, email))
          .limit(1)
      : []
    await seedDemoPlan(tx as unknown as Db, DEMO_STORE_ID, guest?.userId)
    await seedDemoSupport(tx as unknown as Db, DEMO_STORE_ID)
    if (email) {
      await inviteGuest(tx as unknown as Db, DEMO_STORE_ID, "semilla-rosa", email, guest?.userId)
      // La tienda que recién empieza (tablero 16), para ver sus primeros pasos en Inicio.
      await inviteGuest(
        tx as unknown as Db,
        DEMO_NEW_STORE_ID,
        DEMO_NEW_STORE_OWNER,
        email,
        guest?.userId,
      )
    }
  })
}

/**
 * Una invitación de Dueño para quien va a usar la demo, si todavía no es del equipo ni tiene una
 * pendiente: así sembrar otra vez no le deja otra.
 */
async function inviteGuest(
  tx: Db,
  storeId: string,
  invitedBy: string,
  email: string,
  guestId?: string,
): Promise<void> {
  if (guestId) {
    const [member] = await tx
      .select({ role: storeMember.role })
      .from(storeMember)
      .where(and(eq(storeMember.storeId, storeId), eq(storeMember.userId, guestId)))
    if (member) return
  }
  const [pending] = await tx
    .select({ id: storeInvitation.id })
    .from(storeInvitation)
    .where(
      and(
        eq(storeInvitation.storeId, storeId),
        eq(storeInvitation.email, email),
        isNull(storeInvitation.acceptedAt),
        isNull(storeInvitation.revokedAt),
      ),
    )
  if (pending) return
  await tx.insert(storeInvitation).values({
    storeId,
    email,
    role: "owner",
    invitedBy,
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  })
}

/**
 * «Plan y pagos» de ejemplo (B7): lo que respondería la administración, como si ya hubiera
 * preguntado (en desarrollo, sin `GESTORIA_CONTRACT_SECRET`, no se pregunta y queda esto). Un mes
 * pagado, el actual por pagar, un aviso del tope y preguntas respondidas. Quien usa la demo
 * (`guestId`, de `GESTORIA_SEMILLA_CORREO`) ve una suya en la Ayuda: la Ayuda muestra a cada
 * persona solo las suyas. Sin su copia de la cuenta (nunca entró) no se sabe quién es: sembrar
 * otra vez después de entrar la suma.
 */
async function seedDemoPlan(tx: Db, storeId: string, guestId?: string): Promise<void> {
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
    // Cada caso dice quién lo abrió: la Ayuda le muestra a cada persona solo los suyos (ADR 0221).
    support: [
      ...(guestId
        ? [
            {
              id: "semilla-soporte-3",
              status: "esperando_clinica",
              question: "¿Dónde le digo a Sofi el horario de la tienda?",
              createdAt: at(-2),
              userId: guestId,
              replies: [
                {
                  body: "En Sofi, en «Cómo vende»: escríbelo en «Lo que debe saber» y guarda. Sofi lo cuenta tal cual.",
                  at: at(-2),
                },
              ],
            },
          ]
        : []),
      {
        id: "semilla-soporte-2",
        status: "esperando_clinica",
        question: "Un cliente dice que ya pagó por Yape, pero su pedido sigue «Pago por confirmar»",
        createdAt: at(-1),
        userId: "semilla-lucia",
        replies: [
          {
            body: "Su captura está anotada y falta confirmarla: revisa la cuenta de la tienda y, si el pago está, usa «Confirmar pago» en el pedido.",
            at: at(-1),
          },
        ],
      },
      {
        id: "semilla-soporte-1",
        status: "esperando_clinica",
        question: "¿Puedo pagar con Yape?",
        createdAt: at(-3),
        userId: "semilla-rosa",
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

/**
 * Soporte de gestorIA pide mirar la tienda (ADR 0214), como lo pediría la administración: la
 * Dueña lo ve arriba en cada sección y decide. Uno solo, mientras no haya otro por responder.
 */
async function seedDemoSupport(tx: Db, storeId: string): Promise<void> {
  const [pending] = await tx
    .select({ id: storeSupportAccess.id })
    .from(storeSupportAccess)
    .where(and(eq(storeSupportAccess.storeId, storeId), eq(storeSupportAccess.state, "pedido")))
  if (pending) return
  await receiveSupportRequest(tx, {
    account: storeId,
    staff: {
      userId: "semilla-soporte",
      name: "Ana de Soporte (ficticia)",
      email: "soporte@example.test",
    },
    minutes: 30,
    reason: "Revisar contigo por qué no se ven las fotos del catálogo",
  })
}

const isMain = process.argv[1]?.endsWith("semilla.ts")
if (isMain) {
  const url = process.env.GESTORIA_DATABASE_URL
  if (!url)
    throw new Error("GESTORIA_DATABASE_URL es obligatoria para sembrar la tienda de ejemplo")
  const db = createOwnerDb(url, { max: 1 })
  await seedDemoStore(db, process.env.GESTORIA_SEMILLA_CORREO)
  // El perfil de las clientas lo anotan Sofi, Argos y Lucía con sus reglas: con la base de la app.
  const appUrl = process.env.GESTORIA_APP_DATABASE_URL
  if (appUrl) await seedDemoProfiles(db, createAppDb(appUrl, { max: 1 }), DEMO_STORE_ID)
  else console.warn("gestoria: sin GESTORIA_APP_DATABASE_URL, las clientas quedan sin perfil")
  // Los grupos de las clientas: sus compras de meses atrás y lo que calcula la vuelta de la noche.
  await seedDemoSegments(db, DEMO_STORE_ID)
  // Argos pasa por las clientas nuevas de los grupos (lo de sus pedidos) y la noche las recalcula.
  if (appUrl) {
    await profileStore(createAppDb(appUrl, { max: 1 }), DEMO_STORE_ID, new Date())
    await db.transaction((tx) => recomputeStoreIn(tx as unknown as Db, DEMO_STORE_ID))
  }
  console.log("gestoria: Calzados Rosa lista")
  process.exit(0)
}
