/**
 * Cada tienda ve solo lo suyo (ADR 0203), con el rol de la aplicación y una base real: la
 * persona ve sus tiendas y sus invitaciones; dentro de una tienda, su equipo; nada de otra.
 */
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  accountCopy,
  contractOutbox,
  contractState,
  type Db,
  enterStore,
  store,
  storeEvent,
  storeInvitation,
  storeMember,
  withPerson,
} from "./index.js"
import { startTestDb, type TestDb } from "./testing.js"

let db: TestDb
const rosa = { userId: "u-rosa", email: "rosa@calzados.test" }
const mario = { userId: "u-mario", email: "mario@otra.test" }
const lucia = { userId: "u-lucia", email: "lucia@calzados.test" }
const calzados = randomUUID()
const otra = randomUUID()

beforeAll(async () => {
  db = await startTestDb()
  await db.ownerDb.insert(accountCopy).values([
    { userId: rosa.userId, name: "Rosa", email: rosa.email },
    { userId: mario.userId, name: "Mario", email: mario.email },
    { userId: lucia.userId, name: "Lucía", email: lucia.email },
  ])
})

afterAll(async () => {
  await db?.stop()
})

async function createStore(app: Db, who: typeof rosa, id: string, name: string) {
  await withPerson(app, who, async (tx) => {
    await enterStore(tx, id)
    await tx.insert(store).values({ id, name, currency: "PEN", createdBy: who.userId })
    await tx.insert(storeMember).values({ storeId: id, userId: who.userId, role: "owner" })
  })
}

describe("las reglas de cada tienda", () => {
  it("quien crea una tienda la ve, y nadie más; nadie la crea a nombre de otro", async () => {
    await createStore(db.appDb, rosa, calzados, "Calzados Rosa")
    await createStore(db.appDb, mario, otra, "Otra tienda")
    const mine = await withPerson(db.appDb, rosa, (tx) =>
      tx.select({ name: store.name }).from(store),
    )
    expect(mine).toEqual([{ name: "Calzados Rosa" }])
    // A nombre de otra persona, o sin entrar antes a la tienda: no.
    await expect(
      withPerson(db.appDb, rosa, async (tx) => {
        const id = randomUUID()
        await enterStore(tx, id)
        await tx
          .insert(store)
          .values({ id, name: "Falsa", currency: "PEN", createdBy: mario.userId })
      }),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, rosa, (tx) =>
        tx.insert(store).values({
          id: randomUUID(),
          name: "Sin entrar",
          currency: "PEN",
          createdBy: rosa.userId,
        }),
      ),
    ).rejects.toThrow()
  })

  it("dentro de una tienda se ve y se cambia solo su equipo", async () => {
    // Rosa, parada en su tienda, no ve el equipo de la otra ni puede sumarse a ella.
    const team = await withPerson(db.appDb, { ...rosa, storeId: calzados }, (tx) =>
      tx.select({ userId: storeMember.userId }).from(storeMember),
    )
    expect(team).toEqual([{ userId: rosa.userId }])
    await expect(
      withPerson(db.appDb, { ...rosa, storeId: calzados }, (tx) =>
        tx.insert(storeMember).values({ storeId: otra, userId: rosa.userId, role: "owner" }),
      ),
    ).rejects.toThrow()
    // Tampoco escribiendo la tienda ajena en su contexto: no es de su equipo y la base no lo
    // impide por sí sola; por eso la tienda la decide el servidor, nunca el navegador.
    const peeked = await withPerson(db.appDb, { ...rosa, storeId: otra }, (tx) =>
      tx.select({ userId: storeMember.userId }).from(storeMember),
    )
    expect(peeked.map((row) => row.userId).sort()).toEqual([mario.userId, rosa.userId].sort())
  })

  it("una invitación la ve la tienda que invita y el correo invitado, y nadie más", async () => {
    const invitation = randomUUID()
    await withPerson(db.appDb, { ...rosa, storeId: calzados }, async (tx) => {
      await tx.insert(storeInvitation).values({
        id: invitation,
        storeId: calzados,
        email: lucia.email,
        role: "sales",
        invitedBy: rosa.userId,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      await tx
        .insert(storeEvent)
        .values({ storeId: calzados, actorUserId: rosa.userId, action: "invitacion.creada" })
    })
    // Lucía ve su invitación, el nombre de la tienda y quién la invitó, sin ser del equipo.
    const forLucia = await withPerson(db.appDb, lucia, async (tx) => ({
      invitations: await tx.select({ id: storeInvitation.id }).from(storeInvitation),
      stores: await tx.select({ name: store.name }).from(store),
      people: await tx.select({ name: accountCopy.name }).from(accountCopy),
      events: await tx.select().from(storeEvent),
    }))
    expect(forLucia.invitations).toEqual([{ id: invitation }])
    expect(forLucia.stores).toEqual([{ name: "Calzados Rosa" }])
    expect(forLucia.people.map((p) => p.name).sort()).toEqual(["Lucía", "Rosa"])
    expect(forLucia.events).toEqual([])
    // Mario no.
    const forMario = await withPerson(db.appDb, mario, (tx) => tx.select().from(storeInvitation))
    expect(forMario).toEqual([])

    // Acepta: entra a la tienda en la misma transacción y se suma con su rol.
    await withPerson(db.appDb, lucia, async (tx) => {
      await enterStore(tx, calzados)
      await tx
        .insert(storeMember)
        .values({ storeId: calzados, userId: lucia.userId, role: "sales", addedBy: rosa.userId })
      await tx
        .update(storeInvitation)
        .set({ acceptedAt: new Date(), acceptedBy: lucia.userId })
        .where(sql`${storeInvitation.id} = ${invitation}`)
    })
    const stores = await withPerson(db.appDb, lucia, (tx) =>
      tx.select({ name: store.name }).from(store),
    )
    expect(stores).toEqual([{ name: "Calzados Rosa" }])
  })

  it("lo que la aplicación no usa queda cerrado: la copia de las cuentas, los avisos y borrar tiendas", async () => {
    await expect(
      withPerson(db.appDb, rosa, (tx) =>
        tx
          .update(accountCopy)
          .set({ name: "Otra" })
          .where(sql`${accountCopy.userId} = ${rosa.userId}`),
      ),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, rosa, (tx) => tx.execute(sql`select * from account_event_receipt`)),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, { ...rosa, storeId: calzados }, (tx) =>
        tx.delete(store).where(sql`true`),
      ),
    ).rejects.toThrow()
    // Una invitación no cambia de correo ni de rol.
    await expect(
      withPerson(db.appDb, { ...rosa, storeId: calzados }, (tx) =>
        tx.update(storeInvitation).set({ role: "owner" }),
      ),
    ).rejects.toThrow()
  })

  it("el acuerdo con la administración: cada tienda ve lo suyo y solo agrega avisos sin enviar", async () => {
    const event = (storeId: string) => ({
      storeId,
      type: "soporte.pedido" as const,
      payload: { type: "soporte.pedido" },
    })
    await db.ownerDb.insert(contractOutbox).values([event(calzados), event(otra)])
    await db.ownerDb.insert(contractState).values([
      { storeId: calzados, state: { found: true } },
      { storeId: otra, state: { found: true } },
    ])
    const inCalzados = { ...rosa, storeId: calzados }
    const seen = await withPerson(db.appDb, inCalzados, async (tx) => ({
      outbox: await tx.select({ storeId: contractOutbox.storeId }).from(contractOutbox),
      state: await tx.select({ storeId: contractState.storeId }).from(contractState),
    }))
    expect(seen).toEqual({ outbox: [{ storeId: calzados }], state: [{ storeId: calzados }] })
    // No agrega a otra tienda, no da un aviso por enviado y no cambia lo que dijo la administración.
    await expect(
      withPerson(db.appDb, inCalzados, (tx) => tx.insert(contractOutbox).values(event(otra))),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, inCalzados, (tx) =>
        tx.insert(contractOutbox).values({ ...event(calzados), sentAt: new Date() }),
      ),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, inCalzados, (tx) =>
        tx.update(contractOutbox).set({ sentAt: new Date() }),
      ),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, inCalzados, (tx) =>
        tx.update(contractState).set({ state: { found: false } }),
      ),
    ).rejects.toThrow()
  })

  it("sin persona, la aplicación no ve nada", async () => {
    const rows = await db.appDb.transaction((tx) => tx.select().from(store))
    expect(rows).toEqual([])
  })
})
