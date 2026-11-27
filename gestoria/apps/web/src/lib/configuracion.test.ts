import { describe, expect, it } from "vitest"
import {
  CONFIG_HOME_PATH,
  type ConfigOverview,
  configEntryFor,
  configGroupsFor,
  configLines,
  configSectionOf,
  INTEGRATIONS_READY,
  namesIndex,
  SEARCH_INDEX,
  searchConfig,
  toDoItems,
  toDoTitle,
} from "./configuracion"

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
const ADMIN = [...SALES, "equipo.gestionar", "configuracion", "costos.ver", "reportes.ver", "caja"]
const OWNER = [...ADMIN, "plan"]
const SUPPORT = ["tienda.ver", "equipo.ver", "catalogo.ver"]

type Seat = Parameters<typeof configGroupsFor>[0]
const owner: Seat = { role: "owner", permissions: OWNER }
const admin: Seat = { role: "admin", permissions: ADMIN }
const sales: Seat = { role: "sales", permissions: SALES }
const support: Seat = { role: "support", permissions: SUPPORT }

const labels = (store: Seat) =>
  configGroupsFor(store).flatMap((group) => group.items.map((item) => item.label))

describe("qué ve cada rol en Configuración", () => {
  it("el Dueño ve todo, con grupos de tarea; el Administrador, todo menos el plan", () => {
    expect(labels(owner)).toEqual([
      "Lo que falta",
      "Datos de la tienda",
      "Tu marca",
      "Sofi",
      "Cobros",
      "Entregas",
      "Equipo y repartidores",
      "Avisos al celular",
      "Plan y pagos",
    ])
    expect(labels(admin)).not.toContain("Plan y pagos")
    expect(configGroupsFor(admin).map((g) => g.label)).toEqual([
      "Resumen",
      "Tu tienda",
      "Vender",
      "Tu equipo",
      "Para ti",
    ])
  })

  it("Integraciones no se muestra hasta que llegue su pantalla", () => {
    expect(INTEGRATIONS_READY).toBe(false)
    expect(labels(owner)).not.toContain("Integraciones")
    expect(configGroupsFor(owner).map((g) => g.label)).not.toContain("Conexiones")
  })

  it("Configuración abre en «Lo que falta»; Ventas, que no la ve, llega directo a sus avisos", () => {
    expect(configEntryFor(owner)?.path).toBe(CONFIG_HOME_PATH)
    expect(labels(sales)).toEqual(["Avisos al celular"])
    expect(configEntryFor(sales)?.label).toBe("Avisos al celular")
  })

  it("soporte mira lo que falta, la tienda, su equipo, cobros y entregas; sin Sofi ni el plan", () => {
    expect(labels(support)).toEqual([
      "Lo que falta",
      "Datos de la tienda",
      "Tu marca",
      "Cobros",
      "Entregas",
      "Equipo y repartidores",
    ])
  })

  it("cada apartado se encuentra por su ruta exacta", () => {
    expect(configSectionOf("/configuracion")?.label).toBe("Lo que falta")
    expect(configSectionOf("/configuracion/datos")?.label).toBe("Datos de la tienda")
    expect(configSectionOf("/configuracion/marca")?.label).toBe("Tu marca")
    expect(configSectionOf("/configuracion/medios-de-pago")?.label).toBe("Cobros")
    expect(configSectionOf("/configuracion/avisos")?.label).toBe("Avisos al celular")
    expect(configSectionOf("/configuracion/otro")).toBeNull()
  })
})

/** Calzados Rosa: tiene casi todo; le falta la pasarela y probar a Sofi. */
const ROSA: ConfigOverview = {
  steps: [
    { step: "datos", state: "hecho", skippable: false },
    { step: "catalogo", state: "hecho", skippable: false },
    { step: "pagos", state: "hecho", skippable: false },
    { step: "entregas", state: "hecho", skippable: false },
    { step: "chats", state: "pronto", skippable: false },
    { step: "sofi", state: "falta", skippable: true },
    { step: "equipo", state: "hecho", skippable: true },
  ],
  brand: { publicName: "Calzados Rosa", brandColor: "#be185d", logo: true, link: "calzadosrosa" },
  catalog: { products: 32, withStock: 30 },
  payments: [
    { name: "Yape", typeCode: "68", collection: "comprobante" },
    { name: "Plin", typeCode: "68", collection: "comprobante" },
    { name: "Efectivo", typeCode: "10", collection: "al_recibir" },
  ],
  paymentLink: null,
  deliveries: [
    {
      name: "Reparto en Lima",
      type: "DeliveryModeOwnFleet",
      cost: "por_zona",
      zones: 2,
      districts: 12,
      acceptsPayOnDelivery: true,
    },
    {
      name: "Recojo en la tienda",
      type: "OnSitePickup",
      cost: "gratis",
      zones: 0,
      districts: 0,
      acceptsPayOnDelivery: false,
    },
    {
      name: "Shalom",
      type: "ParcelService",
      cost: "se_acuerda",
      zones: 0,
      districts: 0,
      acceptsPayOnDelivery: false,
    },
  ],
  slots: 3,
  team: {
    members: 3,
    invitations: 1,
    couriers: ["Kevin"],
    names: ["Lucía Torres", "Mario Huamán", "Rosa Quispe"],
    supportAsks: 1,
  },
  sofi: { enabled: true, tried: false },
  plan: { name: "Emprende", status: "activa", creditLeftCents: 1035, currency: "USD" },
}

const STORE = { name: "Calzados Rosa", country: "PE", timeZone: "America/Lima", currency: "PEN" }

/** Tortas Carmen: recién creada, con su país y su Yape. */
const CARMEN: ConfigOverview = {
  ...ROSA,
  steps: ROSA.steps.map((s) => ({
    ...s,
    state:
      s.step === "datos" || s.step === "pagos" ? "hecho" : s.step === "chats" ? "pronto" : "falta",
  })),
  brand: { publicName: null, brandColor: null, logo: false, link: null },
  catalog: { products: 0, withStock: 0 },
  payments: [{ name: "Yape", typeCode: "68", collection: "comprobante" }],
  deliveries: [],
  slots: 0,
  team: { members: 1, invitations: 0, couriers: [], names: ["Carmen Huanca"], supportAsks: 0 },
  sofi: { enabled: false, tried: false },
  plan: null,
}

describe("lo que falta para vender", () => {
  it("se marca con lo guardado y cada pendiente trae su botón", () => {
    const items = toDoItems(ROSA, STORE)
    expect(items.map((i) => [i.id, i.state])).toEqual([
      ["datos", "hecho"],
      ["catalogo", "hecho"],
      ["marca", "hecho"],
      ["pagos", "hecho"],
      ["link", "falta"],
      ["entregas", "hecho"],
      ["sofi", "falta"],
    ])
    const link = items.find((i) => i.id === "link")
    expect(link?.action).toEqual({
      label: "Conectar pasarela",
      path: "/configuracion/medios-de-pago",
    })
    expect(link?.detail).toContain("Yape y Plin")
    expect(toDoTitle(items)).toBe("Para vender te faltan 2 cosas")
  })

  it("una tienda que empieza ve lo que le falta, y con todo listo la lista lo dice en una línea", () => {
    const carmen = toDoItems(CARMEN, { ...STORE, name: "Tortas Carmen" })
    expect(carmen.filter((i) => i.state === "falta").map((i) => i.id)).toEqual([
      "catalogo",
      "marca",
      "link",
      "entregas",
      "sofi",
    ])
    const done: ConfigOverview = {
      ...ROSA,
      paymentLink: { provider: "mercadopago" },
      steps: ROSA.steps.map((s) => (s.step === "sofi" ? { ...s, state: "saltado" } : s)),
    }
    const items = toDoItems(done, STORE)
    expect(items.find((i) => i.id === "sofi")?.state).toBe("saltado")
    expect(toDoTitle(items)).toBe("Tienes todo para vender")
  })

  it("a soporte no le llega Sofi, y su paso no se muestra", () => {
    expect(toDoItems({ ...ROSA, sofi: null }, STORE).map((i) => i.id)).not.toContain("sofi")
  })
})

describe("cómo está cada parte", () => {
  it("cada parte en una línea, con su punto si tiene algo pendiente", () => {
    const lines = configLines(ROSA, STORE)
    expect(lines.pagos).toMatchObject({
      summary: "Yape y Plin con captura · Efectivo al recibir",
      status: "Sin pasarela",
      pending: true,
    })
    // El nombre que ya dice cómo se cobra no lo repite.
    const named = configLines(
      {
        ...ROSA,
        payments: [
          { name: "Yape", typeCode: "68", collection: "comprobante" },
          { name: "Efectivo al recibir", typeCode: "10", collection: "al_recibir" },
        ],
      },
      STORE,
    )
    expect(named.pagos?.summary).toBe("Yape con captura · Efectivo al recibir")
    expect(lines.entregas).toMatchObject({
      summary: "Reparto en Lima · recojo en tienda · Shalom",
      status: "12 distritos en 2 zonas",
      pending: false,
    })
    expect(lines.equipo).toMatchObject({
      summary: "3 personas · 1 invitación por aceptar · Kevin reparte",
      status: "Soporte pide mirar",
      pending: true,
    })
    expect(lines.sofi).toMatchObject({ status: "Encendida", pending: true })
    expect(lines.marca).toMatchObject({ status: "Lista", pending: false })
    expect(lines.plan?.summary).toContain("Plan Emprende")
    expect(lines.plan?.status).toBe("Activa")
  })

  it("sin plan conocido ni Sofi (soporte), esas líneas no se dibujan", () => {
    const lines = configLines({ ...ROSA, plan: null, sofi: null }, STORE)
    expect(lines.plan).toBeUndefined()
    expect(lines.sofi).toBeUndefined()
  })
})

describe("el buscador de Configuración", () => {
  const entries = [...SEARCH_INDEX, ...namesIndex(ROSA)]
  const find = (query: string, store: Seat = owner) =>
    searchConfig(query, store, entries).map((r) => `${r.text} › ${r.section.label}`)

  it("encuentra lo que hay dentro de cada parte, con las palabras de quien vende", () => {
    expect(find("yape")).toEqual(
      expect.arrayContaining([
        "Yape › Cobros",
        "Yape, Plin y transferencias › Cobros",
        "Cobrar por link de pago › Cobros",
        "Pago al recibir por forma de entrega › Entregas",
      ]),
    )
    // Lo que se llama igual va primero.
    expect(find("yape")[0]).toBe("Yape › Cobros")
    expect(find("shalom")).toEqual(["Shalom › Entregas", "Envío por agencia › Entregas"])
    expect(find("envío gratis")[0]).toBe("Envío gratis y descuento del envío › Entregas")
    expect(find("horario")).toEqual(
      expect.arrayContaining([
        "Hora de la tienda › Datos de la tienda",
        "Franjas de entrega › Entregas",
      ]),
    )
  })

  it("sin tildes ni mayúsculas, y por los nombres que guardó la tienda", () => {
    expect(find("ENVIO GRATIS")[0]).toBe("Envío gratis y descuento del envío › Entregas")
    expect(find("kevin")).toEqual(["Kevin · repartidor › Equipo y repartidores"])
    expect(find("rosa q")).toEqual(["Rosa Quispe › Equipo y repartidores"])
  })

  it("solo busca en lo que ve quien está, y nada sin escribir", () => {
    expect(find("sofi", support)).toEqual([])
    expect(find("plan", admin)).toEqual([])
    expect(find("avisos", sales)).toEqual(["Avisos al celular › Avisos al celular"])
    expect(find("   ")).toEqual([])
    expect(find("whatsapp")).toEqual([])
  })
})
