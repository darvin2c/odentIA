import {
  accountCopy,
  type Db,
  store,
  storeEvent,
  storeMember,
  storePaymentMethod,
  storeSetup,
} from "@gestoria/db"

/**
 * Tortas Carmen, la tienda que recién empieza (lienzo «gestorIA como odentIA», tablero 16): para
 * ver «Tu tienda está casi lista» en Inicio. Tiene sus datos y su Yape; le faltan el catálogo, las
 * entregas, probar a Sofi y su equipo. Solo para desarrollo y demostraciones, como el resto de
 * `semilla.ts`: quien usa la demo la recibe como invitación de Dueño, igual que Calzados Rosa. Se
 * agrega una vez: si la tienda ya existe, no la toca.
 */
export const DEMO_NEW_STORE_ID = "6a1d6b52-6f73-4a5c-9b3a-5c0a1d0e2402"
export const DEMO_NEW_STORE_OWNER = "semilla-carmen"

export async function seedDemoNewStore(tx: Db): Promise<void> {
  await tx
    .insert(accountCopy)
    .values({
      userId: DEMO_NEW_STORE_OWNER,
      name: "Carmen Huanca",
      email: "carmen@tortascarmen.demo",
    })
    .onConflictDoNothing()
  const [created] = await tx
    .insert(store)
    .values({
      id: DEMO_NEW_STORE_ID,
      name: "Tortas Carmen",
      currency: "PEN",
      country: "PE",
      createdBy: DEMO_NEW_STORE_OWNER,
    })
    .onConflictDoNothing()
    .returning({ id: store.id })
  if (!created) return
  await tx
    .insert(storeMember)
    .values({ storeId: DEMO_NEW_STORE_ID, userId: DEMO_NEW_STORE_OWNER, role: "owner" })
  await tx.insert(storeEvent).values({
    storeId: DEMO_NEW_STORE_ID,
    actorUserId: DEMO_NEW_STORE_OWNER,
    action: "tienda.creada",
  })
  await tx.insert(storePaymentMethod).values({
    storeId: DEMO_NEW_STORE_ID,
    name: "Yape",
    typeCode: "68",
    collection: "comprobante",
    details: "912 345 678 · Carmen Huanca",
  })
}

/**
 * Una tienda que ya vende no es nueva: como las de antes de los primeros pasos (su migración), no
 * ve la lista. Calzados Rosa no probó a Sofi en la demo, pero ya tiene sus pedidos.
 *
 * «Lo que falta» de Configuración (tablero 3 de «gestorIA · Configuración, de nuevo») sí lo dice,
 * porque mira lo guardado y no la lista de Inicio: a Calzados Rosa le falta conectar la pasarela y
 * probar a Sofi, y soporte le pide mirar la tienda; Tortas Carmen ve lo de una tienda que empieza
 * (su catálogo, su marca, la pasarela, sus entregas y Sofi).
 */
export async function seedDemoSetupDone(tx: Db, storeId: string): Promise<void> {
  await tx.insert(storeSetup).values({ storeId, finishedAt: new Date() }).onConflictDoNothing()
}
