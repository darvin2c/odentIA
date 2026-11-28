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
  notYoursText,
  SEARCH_INDEX,
  searchConfig,
  sectionById,
  setupProgress,
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
    { step: "datos", state: "hecho", skippable: false, sells: true },
    { step: "catalogo", state: "hecho", skippable: false, sells: true },
    { step: "pagos", state: "hecho", skippable: false, sells: true },
    { step: "entregas", state: "hecho", skippable: false, sells: true },
    { step: "chats", state: "pronto", skippable: false, sells: true },
    { step: "sofi", state: "falta", skippable: true, sells: true },
    { step: "equipo", state: "hecho", skippable: true, sells: false },
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
      acceptsPayOnDelivery: true,
    },
    {
      name: "Recojo en la tienda",
      type: "OnSitePickup",
      cost: "gratis",
      zones: 0,
      acceptsPayOnDelivery: false,
    },
    {
      name: "Shalom",
      type: "ParcelService",
      cost: "se_acuerda",
      zones: 0,
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
  sofi: { enabled: true, tried: false, toAnswer: 0 },
  plan: {
    name: "Emprende",
    status: "activa",
    creditLeftCents: 1035,
    currency: "USD",
    toPay: false,
  },
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
  sofi: { enabled: false, tried: false, toAnswer: 0 },
  plan: null,
}

describe("lo que falta para vender", () => {
  it("se marca con los pasos del servidor y cada pendiente trae su botón", () => {
    const { selling, more } = toDoItems(ROSA, STORE)
    expect(selling.map((i) => [i.id, i.state])).toEqual([
      ["datos", "hecho"],
      ["catalogo", "hecho"],
      ["pagos", "hecho"],
      ["entregas", "hecho"],
      ["sofi", "falta"],
    ])
    // Tu marca y el link de pago no frenan la venta: van aparte y no son una falta.
    expect(more.map((i) => [i.id, i.state])).toEqual([
      ["marca", "hecho"],
      ["link", "opcional"],
    ])
    const link = more.find((i) => i.id === "link")
    expect(link?.action).toEqual({
      label: "Conectar pasarela",
      path: "/configuracion/medios-de-pago",
    })
    expect(link?.detail).toContain("Yape y Plin")
    // Los chats todavía dicen «Muy pronto»: Sofi no vende sola, y el título no lo promete.
    expect(toDoTitle(ROSA.steps)).toBe("Para vender te falta 1 cosa")
    const withChats = ROSA.steps.map((s) =>
      s.step === "chats" ? { ...s, state: "hecho" as const } : s,
    )
    expect(toDoTitle(withChats)).toBe("Para que Sofi venda sola te falta 1 cosa")
  })

  it("Inicio y Configuración cuentan igual: sin lo de «Muy pronto» ni lo que no frena la venta", () => {
    // Rosa: el equipo hecho no suma; los chats no cuentan. 4 de 5.
    expect(setupProgress(ROSA.steps)).toEqual({ done: 4, total: 5, left: 1 })
    // Carmen: país y Yape. Invitar al equipo falta, pero no frena la venta.
    expect(setupProgress(CARMEN.steps)).toEqual({ done: 2, total: 5, left: 3 })
    const carmen = toDoItems(CARMEN, { ...STORE, name: "Tortas Carmen" })
    expect(carmen.selling.filter((i) => i.state === "falta").map((i) => i.id)).toEqual([
      "catalogo",
      "entregas",
      "sofi",
    ])
    expect(toDoTitle(CARMEN.steps)).toBe("Para vender te faltan 3 cosas")
  })

  it("un link de pago sin pasarela no es una forma de cobrar", () => {
    const onlyLink: ConfigOverview = {
      ...CARMEN,
      // El servidor no manda el link sin pasarela (`chargingPaymentsIn`) ni da el paso por hecho.
      payments: [],
      steps: CARMEN.steps.map((s) => (s.step === "pagos" ? { ...s, state: "falta" } : s)),
    }
    const pagos = toDoItems(onlyLink, STORE).selling.find((i) => i.id === "pagos")
    expect(pagos).toMatchObject({ state: "falta", action: { label: "Agregar un medio" } })
    expect(pagos?.detail).not.toContain("Link de pago")
    expect(configLines(onlyLink, STORE).pagos).toMatchObject({ status: "Falta", pending: true })
  })

  it("con todo listo lo dice; sin Sofi, «para vender»", () => {
    const done: ConfigOverview = {
      ...ROSA,
      paymentLink: { provider: "mercadopago" },
      steps: ROSA.steps.map((s) => (s.step === "sofi" ? { ...s, state: "saltado" } : s)),
    }
    const { selling } = toDoItems(done, STORE)
    expect(selling.find((i) => i.id === "sofi")?.state).toBe("saltado")
    expect(setupProgress(done.steps).left).toBe(0)
    expect(toDoTitle(done.steps)).toBe("Tienes todo para vender")
  })

  it("soporte ve el paso de Sofi, que cuenta igual (sin botón: no cambia nada)", () => {
    const supportView: ConfigOverview = { ...ROSA, sofi: null }
    expect(toDoItems(supportView, STORE).selling.map((i) => i.id)).toContain("sofi")
  })
})

describe("lo que se dice a quien abre una parte ajena", () => {
  it("dice la verdad para cada rol", () => {
    expect(notYoursText(admin, sectionById("plan")).title).toBe(
      "El plan y los pagos los ve el Dueño",
    )
    expect(notYoursText(support, sectionById("sofi")).title).toBe(
      "Soporte de gestorIA no mira esta parte",
    )
    expect(notYoursText(sales, sectionById("marca")).title).toBe(
      "Esto lo cambian el Dueño y el Administrador",
    )
    expect(notYoursText(owner, null).title).toBe("Esta parte no está en Configuración")
  })
})

describe("cómo está cada parte", () => {
  it("cada parte en una línea, con su punto si tiene algo pendiente", () => {
    const lines = configLines(ROSA, STORE)
    expect(lines.pagos).toMatchObject({
      summary: "Yape y Plin con captura · Efectivo al recibir",
      status: "Sin pasarela",
      // Sin pasarela se vende igual: lo dice, sin punto.
      pending: false,
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
      status: "2 zonas",
      pending: false,
    })
    expect(lines.equipo).toMatchObject({
      summary: "3 personas · 1 invitación por aceptar · Kevin reparte",
      status: "Soporte pide mirar",
      pending: true,
    })
    // Lo pendiente va junto a su punto; el estado de siempre, en la línea.
    expect(lines.sofi).toMatchObject({ summary: "Encendida", status: "Sin probar", pending: true })
    expect(lines.marca).toMatchObject({ status: "Lista", pending: false })
    expect(lines.plan?.summary).toContain("Plan Emprende")
    expect(lines.plan?.status).toBe("Activa")
    expect(lines.plan?.pending).toBe(false)
  })

  it("el plan con un cobro por pagar lleva su punto", () => {
    const owing = configLines({ ...ROSA, plan: { ...ROSA.plan!, toPay: true } }, STORE)
    expect(owing.plan).toMatchObject({ status: "Por pagar", pending: true })
    const late = configLines(
      { ...ROSA, plan: { ...ROSA.plan!, status: "gracia", toPay: true } },
      STORE,
    )
    expect(late.plan).toMatchObject({ status: "Pago pendiente", pending: true })
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
    expect(find("plantilla")).toEqual(["Reparto propio y zonas › Entregas"])
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
    // «plan» también empieza «plantilla» (Entregas); lo del plan no sale.
    expect(find("plan", admin).filter((r) => r.endsWith("Plan y pagos"))).toEqual([])
    expect(find("avisos", sales)).toEqual(["Avisos al celular › Avisos al celular"])
    expect(find("   ")).toEqual([])
    expect(find("whatsapp")).toEqual([])
  })
})
