import { describe, expect, it } from "vitest"
import { configGroupsFor, configSectionOf } from "./configuracion"

/** Los permisos de cada rol, como los manda el servidor (`apps/api/src/permisos.ts`). */
const SALES = [
  "tienda.ver",
  "equipo.ver",
  "catalogo.ver",
  "ventas.atender",
  "pagos.confirmar",
  "entregas",
  "ayuda.pedir",
  "avisos.recibir",
]
const ADMIN = [...SALES, "equipo.gestionar", "configuracion", "costos.ver", "reportes.ver"]
const OWNER = [...ADMIN, "plan"]

const labels = (store: Parameters<typeof configGroupsFor>[0]) =>
  configGroupsFor(store).flatMap((group) => group.items.map((item) => item.label))

describe("qué ve cada rol en Configuración", () => {
  it("el Dueño ve todo, también el plan; el Administrador, todo menos el plan", () => {
    expect(labels({ role: "owner", permissions: OWNER })).toEqual([
      "Datos de la tienda",
      "Tu marca",
      "Equipo",
      "Sofi",
      "Medios de pago",
      "Formas de entrega y zonas",
      "Plan y pagos",
    ])
    expect(labels({ role: "admin", permissions: ADMIN })).not.toContain("Plan y pagos")
    expect(configGroupsFor({ role: "admin", permissions: ADMIN }).map((g) => g.label)).toEqual([
      "La tienda",
      "Ventas",
      "Entregas",
    ])
  })

  it("Ventas no ve lo que no puede tocar", () => {
    expect(configGroupsFor({ role: "sales", permissions: SALES })).toEqual([])
  })

  it("soporte mira la tienda, su equipo y lo que cobra y entrega, sin Sofi ni el plan", () => {
    expect(
      labels({ role: "support", permissions: ["tienda.ver", "equipo.ver", "catalogo.ver"] }),
    ).toEqual([
      "Datos de la tienda",
      "Tu marca",
      "Equipo",
      "Medios de pago",
      "Formas de entrega y zonas",
    ])
  })

  it("cada apartado se encuentra por su ruta exacta", () => {
    expect(configSectionOf("/configuracion")?.label).toBe("Datos de la tienda")
    expect(configSectionOf("/configuracion/marca")?.label).toBe("Tu marca")
    expect(configSectionOf("/configuracion/otro")).toBeNull()
  })
})
