import { type Db, storeCourier, storeInvitation } from "@gestoria/db"
import { and, eq, isNull, sql } from "drizzle-orm"

/**
 * Equipo y repartidores de Calzados Rosa (lienzo «gestorIA · Configuración, de nuevo», tablero 9):
 * Kevin, el repartidor de fuera, con su celular y S/ 8 por entrega; Lucía, del equipo, reparte sin
 * pago por entrega; y la invitación de Carla, ya enviada por WhatsApp. Va después de Despachos,
 * que crea a los dos repartidores. Se puede correr otra vez: solo deja los datos así.
 */
export async function seedDemoTeam(tx: Db, storeId: string): Promise<void> {
  await tx
    .update(storeCourier)
    .set({ name: "Kevin Ramos", phone: "+51955101202", payCents: 800, failedTripPaid: true })
    .where(
      and(
        eq(storeCourier.storeId, storeId),
        isNull(storeCourier.userId),
        sql`lower(btrim(${storeCourier.name})) in ('kevin', 'kevin ramos')`,
      ),
    )
  await tx
    .update(storeInvitation)
    .set({
      name: "Carla Vega",
      phone: "+51912345678",
      sharedAt: new Date(Date.now() - 2 * 86_400_000),
      sharedBy: "semilla-rosa",
    })
    .where(
      and(
        eq(storeInvitation.storeId, storeId),
        eq(storeInvitation.email, "carla.ventas@calzadosrosa.demo"),
        isNull(storeInvitation.acceptedAt),
        isNull(storeInvitation.revokedAt),
      ),
    )
}
