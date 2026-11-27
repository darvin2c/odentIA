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
  pushChoice,
  pushDevice,
  store,
  storeEvent,
  storeImage,
  storeInvitation,
  storeLink,
  storeMember,
  storeSetup,
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

  it("«Tu marca»: cada tienda cambia solo la suya, el nombre del link no se repite y el agente no la toca", async () => {
    const inCalzados = async <T>(
      fn: (tx: Db) => Promise<T>,
      who: { userId: string; email: string } = rosa,
    ) =>
      withPerson(db.appDb, who, async (tx) => {
        await enterStore(tx, calzados)
        return fn(tx)
      })
    await inCalzados((tx) =>
      tx.update(store).set({ publicName: "Rosa Calzados", brandColor: "#be185d" }),
    )
    await inCalzados((tx) =>
      tx.insert(storeImage).values({
        storeId: calzados,
        kind: "logo",
        contentType: "image/png",
        content: Buffer.from([1, 2, 3]),
        updatedBy: rosa.userId,
      }),
    )
    await inCalzados((tx) =>
      tx
        .insert(storeLink)
        .values({ name: "calzadosrosa", storeId: calzados, createdBy: rosa.userId }),
    )
    // La moneda no se cambia, y un color que no es un color tampoco.
    await expect(inCalzados((tx) => tx.update(store).set({ currency: "USD" }))).rejects.toThrow()
    await expect(inCalzados((tx) => tx.update(store).set({ brandColor: "rosa" }))).rejects.toThrow()
    // Otra tienda no ve ni usa lo de Calzados: su nombre del link ya está tomado.
    const fromOther = await withPerson(db.appDb, mario, async (tx) => {
      await enterStore(tx, otra)
      return {
        images: await tx.select({ kind: storeImage.kind }).from(storeImage),
        links: await tx.select({ name: storeLink.name }).from(storeLink),
      }
    })
    expect(fromOther).toEqual({ images: [], links: [] })
    await expect(
      withPerson(db.appDb, mario, async (tx) => {
        await enterStore(tx, otra)
        await tx
          .insert(storeLink)
          .values({ name: "calzadosrosa", storeId: otra, createdBy: mario.userId })
      }),
    ).rejects.toThrow()
    // Dos vigentes en la misma tienda, no.
    await expect(
      inCalzados((tx) =>
        tx
          .insert(storeLink)
          .values({ name: "rosa-dos", storeId: calzados, createdBy: rosa.userId }),
      ),
    ).rejects.toThrow()
    // Sofi no cambia la tienda ni su marca.
    const sofi = { userId: "agente:sofi", email: "" }
    await inCalzados(async (tx) => {
      const changed = await tx
        .update(store)
        .set({ brandColor: "#000000" })
        .returning({ id: store.id })
      expect(changed).toEqual([])
      const removed = await tx.delete(storeImage).returning({ kind: storeImage.kind })
      expect(removed).toEqual([])
    }, sofi)
    const [after] = await inCalzados((tx) =>
      tx.select({ brandColor: store.brandColor }).from(store),
    )
    expect(after?.brandColor).toBe("#be185d")
  })

  it("los primeros pasos: cada tienda anota los suyos, a su nombre o sin nombre; el agente no los toca y no se borran", async () => {
    const inCalzados = async <T>(
      fn: (tx: Db) => Promise<T>,
      who: { userId: string; email: string } = rosa,
    ) =>
      withPerson(db.appDb, who, async (tx) => {
        await enterStore(tx, calzados)
        return fn(tx)
      })
    await inCalzados((tx) =>
      tx
        .insert(storeSetup)
        .values({ storeId: calzados, skipped: ["equipo"], updatedBy: rosa.userId }),
    )
    // Quedó lista: lo anota el sistema, sin nombre.
    await inCalzados((tx) => tx.update(storeSetup).set({ finishedAt: new Date(), updatedBy: null }))
    // Un paso que no existe, no; a nombre de otra persona, tampoco.
    await expect(
      inCalzados((tx) =>
        tx.update(storeSetup).set({ skipped: ["equipo", "otro"] as unknown as ["equipo"] }),
      ),
    ).rejects.toThrow()
    await expect(
      inCalzados((tx) => tx.update(storeSetup).set({ updatedBy: mario.userId })),
    ).rejects.toThrow()
    // No se borra: así la lista no vuelve.
    await expect(inCalzados((tx) => tx.delete(storeSetup))).rejects.toThrow()
    // Otra tienda no la ve ni la anota por Calzados.
    const fromOther = await withPerson(db.appDb, mario, async (tx) => {
      await enterStore(tx, otra)
      return tx.select({ storeId: storeSetup.storeId }).from(storeSetup)
    })
    expect(fromOther).toEqual([])
    await expect(
      withPerson(db.appDb, mario, async (tx) => {
        await enterStore(tx, otra)
        await tx.insert(storeSetup).values({ storeId: calzados, updatedBy: mario.userId })
      }),
    ).rejects.toThrow()
    // Sofi no la cambia ni la crea.
    const sofi = { userId: "agente:sofi", email: "" }
    await inCalzados(async (tx) => {
      const changed = await tx
        .update(storeSetup)
        .set({ finishedAt: null, updatedBy: null })
        .returning({ storeId: storeSetup.storeId })
      expect(changed).toEqual([])
    }, sofi)
    // Crear (también al anotar sobre la que ya está) lo revisa la regla de crear: el agente, no.
    await expect(
      inCalzados(
        (tx) =>
          tx
            .insert(storeSetup)
            .values({ storeId: calzados })
            .onConflictDoUpdate({ target: storeSetup.storeId, set: { finishedAt: null } }),
        sofi,
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } })
    const [after] = await inCalzados((tx) =>
      tx
        .select({ skipped: storeSetup.skipped, finishedAt: storeSetup.finishedAt })
        .from(storeSetup),
    )
    expect(after?.skipped).toEqual(["equipo"])
    expect(after?.finishedAt).not.toBeNull()
  })

  it("los avisos al celular: cada persona ve y cambia solo sus celulares y lo que elige, sin el sistema", async () => {
    const device = (userId: string, endpoint: string) => ({
      userId,
      endpoint,
      p256dh: "clave",
      auth: "secreto",
    })
    await withPerson(db.appDb, rosa, (tx) =>
      tx.insert(pushDevice).values(device(rosa.userId, "https://fcm.googleapis.com/fcm/send/rosa")),
    )
    // A nombre de otra persona, o ya con el «Listo» anotado: no.
    await expect(
      withPerson(db.appDb, rosa, (tx) =>
        tx.insert(pushDevice).values(device(mario.userId, "https://fcm.googleapis.com/fcm/send/x")),
      ),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, rosa, (tx) =>
        tx.insert(pushDevice).values({
          ...device(rosa.userId, "https://fcm.googleapis.com/fcm/send/y"),
          welcomedAt: new Date(),
        }),
      ),
    ).rejects.toThrow()
    const seenByMario = await withPerson(db.appDb, mario, (tx) =>
      tx.select({ id: pushDevice.id }).from(pushDevice),
    )
    expect(seenByMario).toEqual([])
    const removedByMario = await withPerson(db.appDb, mario, (tx) =>
      tx.delete(pushDevice).returning({ id: pushDevice.id }),
    )
    expect(removedByMario).toEqual([])

    // Lo que elige: solo en su tienda, sin anotar hasta dónde miró el sistema.
    const inCalzados = { ...rosa, storeId: calzados }
    await withPerson(db.appDb, inCalzados, (tx) =>
      tx.insert(pushChoice).values({ storeId: calzados, userId: rosa.userId, kinds: ["pagos"] }),
    )
    await expect(
      withPerson(db.appDb, inCalzados, (tx) => tx.update(pushChoice).set({ lastEventSeq: 99 })),
    ).rejects.toThrow()
    await expect(
      withPerson(db.appDb, inCalzados, (tx) =>
        tx.insert(pushChoice).values({ storeId: calzados, userId: lucia.userId, kinds: [] }),
      ),
    ).rejects.toThrow()
    // Lo que no es un aviso, no.
    await expect(
      withPerson(db.appDb, inCalzados, (tx) =>
        tx
          .update(pushChoice)
          .set({ kinds: ["otro"] as unknown as ["pagos"] })
          .where(sql`true`),
      ),
    ).rejects.toThrow()
    const fromOther = await withPerson(db.appDb, { ...mario, storeId: otra }, (tx) =>
      tx.select().from(pushChoice),
    )
    expect(fromOther).toEqual([])
    // Sofi no ve ni toca nada de esto.
    const sofi = { userId: "agente:sofi", email: "", storeId: calzados }
    const bySofi = await withPerson(db.appDb, sofi, async (tx) => ({
      devices: await tx.select().from(pushDevice),
      choices: await tx.select().from(pushChoice),
    }))
    expect(bySofi).toEqual({ devices: [], choices: [] })
  })

  it("sin persona, la aplicación no ve nada", async () => {
    const rows = await db.appDb.transaction((tx) => tx.select().from(store))
    expect(rows).toEqual([])
  })
})
