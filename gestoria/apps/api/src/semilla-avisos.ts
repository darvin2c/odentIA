import { type Db, pushChoice } from "@gestoria/db"

/**
 * Los avisos al celular de Calzados Rosa (tablero 15): lo que eligió cada persona del equipo de
 * ejemplo. Lucía (Ventas) suma los pedidos que armó Sofi, que a su rol no le llegan sin elegirlos;
 * Mario (Administrador) apaga lo de dinero. Rosa (Dueño) deja lo de su rol. Los celulares no se
 * siembran: son suscripciones reales de un navegador. Solo para desarrollo y demostraciones, como
 * el resto de `semilla.ts`; si alguien ya eligió, no lo toca.
 */
export async function seedDemoPushChoices(tx: Db, storeId: string): Promise<void> {
  await tx
    .insert(pushChoice)
    .values([
      {
        storeId,
        userId: "semilla-lucia",
        kinds: ["pagos", "chats", "no_entregado", "sofi_pedido"],
      },
      {
        storeId,
        userId: "semilla-mario",
        kinds: ["pagos", "chats", "no_entregado", "sofi_pedido"],
      },
    ])
    .onConflictDoNothing()
}
