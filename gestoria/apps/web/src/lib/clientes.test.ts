import { describe, expect, it } from "vitest"
import {
  type CustomerHistoryItem,
  channelsText,
  customerSearch,
  filtersOf,
  groupNameOf,
  hasFilters,
  historyText,
  lastBoughtText,
  listQuery,
  owedText,
  priceText,
  purchasesText,
  reasonText,
  sameFilters,
  searchOfGroup,
  sinceText,
  whatsappLink,
} from "./clientes"

const item = (over: Partial<CustomerHistoryItem>): CustomerHistoryItem => ({
  id: "e1",
  action: "unida",
  createdAt: "2026-11-26T14:40:00Z",
  actorName: "Lucía Torres",
  self: false,
  with: { id: "c2", name: "Mari R." },
  separates: "c2",
  ...over,
})

describe("cómo se dice una clienta", () => {
  it("lo que debe, con la cifra del servidor, y nada si no debe", () => {
    expect(owedText({ dueCents: 0, dueOnDelivery: false }, "PEN")).toBeNull()
    expect(owedText({ dueCents: 3700, dueOnDelivery: false }, "PEN")).toMatch(/^Debe S\/\s37$/)
    expect(owedText({ dueCents: 20400, dueOnDelivery: true }, "PEN")).toMatch(
      /^Debe S\/\s204 · contra entrega$/,
    )
  })

  it("sus canales, sin «otro»", () => {
    expect(channelsText(["whatsapp", "instagram", "otro"])).toBe("WhatsApp · Instagram")
    expect(channelsText([])).toBe("")
  })

  it("sus compras, con el día de la última en la hora de la tienda", () => {
    const lima = "America/Lima"
    expect(purchasesText(0, null, lima, "2026-11-26")).toBe("Sin compras")
    expect(purchasesText(1, "2026-11-26T15:00:00Z", lima, "2026-11-26")).toBe(
      "1 compra · la última hoy",
    )
    expect(purchasesText(3, "2026-11-25T15:00:00Z", lima, "2026-11-26")).toBe(
      "3 compras · la última ayer",
    )
    // Las 02:00 en Londres del 26 son todavía las 21:00 del 25 en Lima: fue ayer.
    expect(purchasesText(1, "2026-11-26T02:00:00Z", lima, "2026-11-26")).toBe(
      "1 compra · la última ayer",
    )
  })

  it("desde cuándo es clienta, sin puntos ni «de»", () => {
    expect(sinceText("2026-10-10T15:00:00")).toBe("clienta desde oct 2026")
  })

  it("escribirle por WhatsApp con su código, o como del país de la tienda; lo envía la persona", () => {
    expect(whatsappLink(["987 654 321", "+51 987 654 321"])).toBe("https://wa.me/51987654321")
    // Anotado sin el código: en una tienda del Perú es un celular del Perú.
    expect(whatsappLink(["987 654 321"], "PE")).toBe("https://wa.me/51987654321")
    // El que trae su código manda, aunque la tienda sea de otro país.
    expect(whatsappLink(["+56 9 6123 4567"], "PE")).toBe("https://wa.me/56961234567")
    // Sin el país de la tienda no se adivina; lo que no es un número, tampoco.
    expect(whatsappLink(["987 654 321"])).toBeNull()
    expect(whatsappLink(["123"], "PE")).toBeNull()
    expect(whatsappLink([])).toBeNull()
  })

  it("por qué se sugiere que son la misma", () => {
    expect(reasonText("telefono")).toBe("Tienen el mismo teléfono.")
    expect(reasonText("nombre")).toBe("Tienen el mismo nombre.")
  })

  it("lo que decidió el equipo, desde la ficha que se ve", () => {
    expect(historyText(item({}))).toBe(
      "Lucía Torres dijo que «Mari R.» es la misma clienta: su ficha quedó dentro de esta.",
    )
    expect(historyText(item({ self: true, with: { id: "c1", name: "Mariela Ríos" } }))).toBe(
      "Lucía Torres dijo que esta ficha es la misma clienta que «Mariela Ríos».",
    )
    expect(historyText(item({ action: "separada" }))).toBe(
      "Lucía Torres separó «Mari R.»: volvió a ser otra ficha.",
    )
    expect(historyText(item({ action: "separada", self: true }))).toBe(
      "Lucía Torres separó esta ficha de «Mari R.».",
    )
    expect(historyText(item({ action: "distintas", actorName: null }))).toBe(
      "Alguien del equipo dijo que «Mari R.» es otra clienta.",
    )
  })
})

describe("los filtros de Clientes, en la dirección", () => {
  it("toma solo lo que vale: un grupo que no existe o un orden ajeno se descartan", () => {
    expect(
      customerSearch({
        grupo: "riesgo",
        medida: " 38 ",
        promociones: "si",
        sort: "-gasto",
        q: "",
        otro: "x",
      }),
    ).toEqual({ grupo: "riesgo", medida: "38", promociones: "si", sort: "-gasto" })
    expect(customerSearch({ grupo: "oro", promociones: "talvez", sort: "nombre" })).toEqual({})
  })

  it("el orden va como «orden» al servidor, sin la flecha del menú", () => {
    const filters = filtersOf({ grupo: "vip", sort: "-gasto", q: "ana" })
    expect(filters).toEqual({ grupo: "vip", orden: "gasto" })
    expect(listQuery(filters, "ana")).toBe("?grupo=vip&orden=gasto&q=ana")
    expect(listQuery({})).toBe("")
  })

  it("el orden solo no es un grupo que se pueda guardar", () => {
    expect(hasFilters({ orden: "gasto" })).toBe(false)
    expect(hasFilters({ distrito: "Surco" })).toBe(true)
  })

  it("un grupo guardado reemplaza lo elegido y se reconoce como el de ahora", () => {
    const saved = { grupo: "riesgo" as const, categoria: "Sandalias" }
    expect(searchOfGroup(saved)).toEqual({
      q: undefined,
      grupo: "riesgo",
      medida: undefined,
      categoria: "Sandalias",
      distrito: undefined,
      promociones: undefined,
      sort: undefined,
    })
    expect(sameFilters(saved, { categoria: "Sandalias", grupo: "riesgo" })).toBe(true)
    expect(sameFilters(saved, { grupo: "riesgo" })).toBe(false)
    expect(groupNameOf(saved)).toBe("En riesgo · Sandalias")
    expect(groupNameOf({})).toBe("Mi grupo")
  })
})

describe("lo que Argos calcula, en palabras", () => {
  it("la última compra se cuenta en días de la tienda", () => {
    expect(lastBoughtText(null)).toBe("Sin compras")
    expect(lastBoughtText(0)).toBe("Hoy")
    expect(lastBoughtText(1)).toBe("Ayer")
    expect(lastBoughtText(12)).toBe("Hace 12 días")
  })

  it("el precio dice cómo compra, con su porqué", () => {
    expect(priceText({ priceSensitivity: null, sensitivityWhy: null })).toEqual({
      value: "Paga el precio normal",
      why: "sin rebaja en sus compras",
    })
    expect(
      priceText({ priceSensitivity: "rebaja", sensitivityWhy: "2 de 3 compras con rebaja" }),
    ).toEqual({ value: "Pide rebaja", why: "2 de 3 compras con rebaja" })
  })
})

describe("una talla en la dirección", () => {
  it("vale aunque la dirección la lea como número", () => {
    expect(customerSearch({ medida: 37 }).medida).toBe("37")
    expect(filtersOf(customerSearch({ grupo: "frecuente", medida: 37 }))).toEqual({
      grupo: "frecuente",
      medida: "37",
    })
  })
})
