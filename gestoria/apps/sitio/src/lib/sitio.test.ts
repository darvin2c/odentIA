import { describe, expect, it } from "vitest"
import { hasPending, PRIVACIDAD, segments, TERMINOS } from "./legal"
import {
  CONTACT_EMAIL,
  footerGroups,
  footerLinks,
  hrefOf,
  LOGIN_URL,
  mainNav,
  primaryCta,
  REGISTER_URL,
  SITE_MAP,
  salesWhatsAppHref,
  TIENDAS_ABIERTAS,
} from "./sitio"

describe("el WhatsApp de ventas", () => {
  it("abre el chat con el mensaje de gestorIA ya escrito", () => {
    expect(salesWhatsAppHref("+51987654321")).toBe(
      "https://wa.me/51987654321?text=Hola%2C%20quiero%20informaci%C3%B3n%20de%20gestorIA",
    )
  })

  it("sin un número E.164 no hay botón", () => {
    expect(salesWhatsAppHref(undefined)).toBeNull()
    expect(salesWhatsAppHref("")).toBeNull()
    expect(salesWhatsAppHref("987654321")).toBeNull()
    expect(salesWhatsAppHref("+51 987 654 321")).toBeNull()
  })
})

describe("el botón principal", () => {
  const wa = salesWhatsAppHref("+51987654321")

  it("desde la web v3 es crear la tienda", () => {
    expect(TIENDAS_ABIERTAS).toBe(true)
  })

  it("con las tiendas cerradas, es hablar con nosotros", () => {
    expect(primaryCta(false, wa)).toEqual({
      href: wa,
      label: "Escríbenos por WhatsApp",
      short: "Escríbenos",
    })
  })

  it("sin el número de ventas, lleva a la página de contacto", () => {
    expect(primaryCta(false, null)).toEqual({
      href: "/contacto",
      label: "Escríbenos",
      short: "Escríbenos",
    })
  })

  it("con las tiendas abiertas, es crear la tienda en la app", () => {
    expect(primaryCta(true, wa)).toEqual({
      href: REGISTER_URL,
      label: "Crea tu tienda",
      short: "Crea tu tienda",
    })
    expect(REGISTER_URL).toBe("https://app.gestoria24.com/register")
  })
})

describe("los enlaces", () => {
  const pie = [...footerGroups.flatMap((g) => g.links), ...footerLinks]

  it("el pie lleva a lo que enlazan los correos de la cuenta y a entrar", () => {
    const hrefs = pie.map((l) => l.href)
    for (const href of [
      "/terminos",
      "/privacidad",
      "/contacto",
      "https://app.gestoria24.com/login",
    ])
      expect(hrefs).toContain(href)
    expect(LOGIN_URL).toBe("https://app.gestoria24.com/login")
    expect(CONTACT_EMAIL).toBe("hola@gestoria24.com")
  })

  it("una página que no existe no se enlaza: lleva a su parte del Inicio o no aparece", () => {
    const pages = Object.values(SITE_MAP).flat()
    for (const p of pages) {
      const href = hrefOf(p)
      if (p.lista) expect(href).toBe(p.path)
      else expect(href === null || href.startsWith("/#")).toBe(true)
    }
    expect(pages.length).toBeGreaterThanOrEqual(18)
  })

  it("cada enlace lleva a un solo lugar y cada lugar tiene un solo nombre", () => {
    const all = [...mainNav, ...pie].filter((l) => l.label !== "Producto")
    const byHref = new Map<string, Set<string>>()
    for (const l of all) byHref.set(l.href, (byHref.get(l.href) ?? new Set()).add(l.label))
    for (const [href, labels] of byHref) expect([href, labels.size]).toEqual([href, 1])
  })

  it("cada grupo del pie tiene enlaces", () => {
    for (const g of footerGroups) expect(g.links.length).toBeGreaterThan(0)
  })
})

describe("términos y privacidad", () => {
  it("mientras tengan marcas, se sabe", () => {
    expect(hasPending(TERMINOS)).toBe(true)
    expect(hasPending(PRIVACIDAD)).toBe(true)
    expect(hasPending({ ...TERMINOS, since: "1 de enero de 2027", sections: [] })).toBe(false)
  })

  it("llevan los datos de la empresa", () => {
    for (const doc of [TERMINOS, PRIVACIDAD])
      expect(JSON.stringify(doc.sections[0])).toContain(
        "SALLCA GROUP E.I.R.L., con RUC 20603338741",
      )
  })

  it("separa los marcadores y los enlaces del texto", () => {
    expect(segments("Escríbenos a [hola](mailto:hola@x.com). [Por completar: fecha]")).toEqual([
      { text: "Escríbenos a " },
      { text: "hola", href: "mailto:hola@x.com" },
      { text: ". " },
      { text: "[Por completar: fecha]", mark: true },
    ])
    expect(segments("Sin nada")).toEqual([{ text: "Sin nada" }])
  })
})
