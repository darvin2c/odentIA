import { type AppEvent, TEAM_ROLES } from "@odentia/contract"
import { appContractMessage } from "@odentia/db/schema/admin-accounts"
import { userGlobalBlock } from "@odentia/db/schema/admin-organizations"
import { APP_PLACE_ROLES, appPlace, appPlaceMember, user } from "@odentia/db/schema/auth"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { closeMyAccount } from "./admin-organizations.js"
import { receiveAppEvent } from "./app-contract.js"
import { listMyAppPlaces } from "./app-places.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * La copia de los lugares de las otras apps en la cuenta (ADR 0216): gestorIA avisa el equipo
 * entero de cada tienda; la cuenta lo guarda, lo muestra en el selector y no cierra la cuenta del
 * único Dueño de una tienda.
 */

setupTestDb()

const team = (
  account: string,
  at: string,
  members: Array<{ userId: string; role: (typeof TEAM_ROLES)[number] }>,
  name = "Calzados Rosa",
): AppEvent => ({ type: "equipo.cambiado", timestamp: at, data: { account, name, members } })

async function person(id: string): Promise<void> {
  await ownerDb.insert(user).values({ id, name: id, email: `${id}@tiendas.test` })
}

describe("los lugares de las otras apps", () => {
  it("los roles de la base son los del acuerdo", () => {
    expect([...APP_PLACE_ROLES]).toEqual([...TEAM_ROLES])
  })

  it("guarda el equipo entero, no repite por su clave y uno más viejo no pisa al más nuevo", async () => {
    const store = "tienda-copia"
    await receiveAppEvent(
      ownerDb,
      "gestoria",
      "equipo-1",
      team(store, "2026-11-25T10:00:00.000Z", [
        { userId: "rosa", role: "owner" },
        { userId: "ana", role: "sales" },
      ]),
    )
    expect(await listMyAppPlaces(ownerDb, "ana")).toEqual([
      { app: "gestoria", id: store, name: "Calzados Rosa", role: "sales", roleLabel: "Ventas" },
    ])
    // La misma clave otra vez: repetido, sin tocar nada.
    expect(
      await receiveAppEvent(
        ownerDb,
        "gestoria",
        "equipo-1",
        team(store, "2026-11-25T12:00:00.000Z", []),
      ),
    ).toEqual({ repeated: true })
    expect(await listMyAppPlaces(ownerDb, "ana")).toHaveLength(1)

    // Ana sale y la tienda cambia de nombre.
    await receiveAppEvent(
      ownerDb,
      "gestoria",
      "equipo-2",
      team(store, "2026-11-25T11:00:00.000Z", [{ userId: "rosa", role: "owner" }], "Rosa Moda"),
    )
    expect(await listMyAppPlaces(ownerDb, "ana")).toEqual([])
    expect(await listMyAppPlaces(ownerDb, "rosa")).toEqual([
      { app: "gestoria", id: store, name: "Rosa Moda", role: "owner", roleLabel: "Dueño" },
    ])

    // Un reintento de antes llega tarde: no la vuelve a poner.
    await receiveAppEvent(
      ownerDb,
      "gestoria",
      "equipo-0",
      team(store, "2026-11-25T09:00:00.000Z", [
        { userId: "rosa", role: "owner" },
        { userId: "ana", role: "admin" },
      ]),
    )
    expect(await listMyAppPlaces(ownerDb, "ana")).toEqual([])
    // Su clave queda (no se reintenta), sin cuenta de cobro: la administración no conoce la tienda.
    const [message] = await ownerDb
      .select()
      .from(appContractMessage)
      .where(and(eq(appContractMessage.app, "gestoria"), eq(appContractMessage.id, "equipo-0")))
    expect(message).toMatchObject({ type: "equipo.cambiado", accountId: null })

    // Ya no queda nadie.
    await receiveAppEvent(
      ownerDb,
      "gestoria",
      "equipo-3",
      team(store, "2026-11-25T13:00:00.000Z", []),
    )
    expect(await listMyAppPlaces(ownerDb, "rosa")).toEqual([])
    const [place] = await ownerDb.select().from(appPlace).where(eq(appPlace.ref, store))
    expect(place?.name).toBe("Calzados Rosa")
  })

  it("no cierra la cuenta del único Dueño de una tienda y dice cuál; con otro Dueño, sí", async () => {
    for (const id of ["sola", "socia", "vende"]) await person(id)
    await receiveAppEvent(
      ownerDb,
      "gestoria",
      "cierre-1",
      team(
        "tienda-sola",
        "2026-11-25T10:00:00.000Z",
        [
          { userId: "sola", role: "owner" },
          // Un Administrador no basta: la tienda necesita un Dueño.
          { userId: "vende", role: "admin" },
        ],
        "Rosita Moda",
      ),
    )
    await receiveAppEvent(
      ownerDb,
      "gestoria",
      "cierre-2",
      team(
        "tienda-dos",
        "2026-11-25T10:00:00.000Z",
        [
          { userId: "sola", role: "owner" },
          { userId: "socia", role: "owner" },
        ],
        "Dos Dueñas",
      ),
    )
    await expect(ownerDb.transaction((tx) => closeMyAccount(tx, "sola"))).rejects.toMatchObject({
      status: 409,
      message:
        "La tienda Rosita Moda necesita al menos un Dueño y eres el único: antes, en gestorIA, haz Dueño a otra persona.",
    })
    // Nada se cerró.
    expect(
      await ownerDb.select().from(userGlobalBlock).where(eq(userGlobalBlock.userId, "sola")),
    ).toEqual([])

    // Quien atiende cierra la suya sin problema; y la socia, porque la otra Dueña sigue.
    await ownerDb.transaction((tx) => closeMyAccount(tx, "vende"))
    await ownerDb.transaction((tx) => closeMyAccount(tx, "socia"))
    const blocked = await ownerDb.select({ userId: userGlobalBlock.userId }).from(userGlobalBlock)
    expect(blocked.map((row) => row.userId).sort()).toEqual(
      expect.arrayContaining(["socia", "vende"]),
    )

    // La socia ya cerró, aunque gestorIA todavía no avisó que salió: ahora es la única en las dos,
    // y las nombra a las dos.
    await expect(ownerDb.transaction((tx) => closeMyAccount(tx, "sola"))).rejects.toMatchObject({
      message:
        "Las tiendas Dos Dueñas y Rosita Moda necesitan al menos un Dueño y eres el único: antes, en gestorIA, haz Dueño a otra persona en cada una.",
    })
    // La copia no la cambia nadie más que el aviso de la app.
    expect(
      await ownerDb.select().from(appPlaceMember).where(eq(appPlaceMember.userId, "sola")),
    ).toHaveLength(2)
  })
})
