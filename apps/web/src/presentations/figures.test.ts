import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { withClinic, withoutGuide } from "./figures"
import latidiaDeck from "./latidia/deck.html?raw"
import clinicSlide from "./odentia/clinic-slide.html?raw"
import odentiaDeck from "./odentia/deck.html?raw"
import voiceScript from "./odentia/voz/guion.md?raw"

describe("la v2 de odentIA, con la clínica en 3D", () => {
  const parts = (html: string) => html.match(/<section class="slide[^"]*" aria-label="[^"]*"/g)

  it("lleva a la clínica lo que se ve pasar y deja aparte lo que hay que leer", () => {
    const out = withClinic(odentiaDeck, clinicSlide)
    const names = (html: string) => parts(html)?.map((p) => p.split('aria-label="')[1].slice(0, -1))
    expect(names(out)).toEqual([
      "Lo que creemos",
      "Lo que hacemos",
      "Tus agentes",
      "Todo lo de siempre",
      "Solo cobramos por valor",
      "Tu semana con odentIA",
      "Tu precio",
      "Ser clínica fundadora",
    ])
    expect(out).toContain('data-scene="clinic"')
    expect(out).not.toContain('data-scene="log"')
    expect(out).not.toContain('data-scene="notifs"')
  })

  it("cada momento de la clínica tiene su tema, con qué trabaja y su texto en el guion de la voz", () => {
    const layers = clinicSlide.match(/<div class="layer[^>]*>/g) ?? []
    expect(layers.length).toBeGreaterThan(12)
    for (const layer of layers) {
      expect(layer).toMatch(/data-topic="[a-z]+"/)
      expect(layer).toMatch(/data-sc="(hoy|bot|crm|con)"/)
    }
    const keys = layers.map(
      (l) => `${/data-topic="(\w+)"/.exec(l)?.[1]}-${/data-sc="(\w+)"/.exec(l)?.[1]}`,
    )
    for (const key of keys) {
      expect(voiceScript).toContain(`## ${key}\n`)
      // Sin su audio ese momento se queda callado.
      expect(
        existsSync(new URL(`../../public/presentacion/voz/${key}.mp3`, import.meta.url)),
        key,
      ).toBe(true)
    }
    // Cada tema se puede ver como es hoy y con odentIA; ninguno se repite.
    expect(new Set(keys).size).toBe(keys.length)
    for (const t of ["dia", "noche", "mostrador", "consulta", "fueron", "direccion"]) {
      expect(keys).toContain(`${t}-hoy`)
      expect(keys).toContain(`${t}-con`)
    }
  })

  it("cada presentación empieza por lo que creemos y lo que hacemos, sin vender", () => {
    for (const deck of [odentiaDeck, latidiaDeck]) {
      const names = parts(deck)?.map((p) => p.split('aria-label="')[1].slice(0, -1))
      expect(names?.slice(0, 2)).toEqual(["Lo que creemos", "Lo que hacemos"])
      // Sin cifras ni programa: primero se entiende quiénes somos.
      expect(deck.split("<section ").slice(1, 3).join("")).not.toMatch(
        /\{\{(?!ecg)|Programa Fundadores/,
      )
    }
  })

  it("el cierre de cada presentación deja juntos los beneficios y cómo entrar", () => {
    for (const deck of [odentiaDeck, latidiaDeck]) {
      const last = parts(deck)?.at(-1)
      expect(last).toMatch(/fundador/i)
      expect(deck).not.toContain('aria-label="Cómo entrar"')
      expect(deck.lastIndexOf('aria-label="Tu precio"')).toBeLessThan(
        deck.lastIndexOf('class="perks"'),
      )
      expect(deck.lastIndexOf('class="perks"')).toBeLessThan(deck.lastIndexOf('class="btn"'))
      // El regalo se ofrece al final: primero se ve qué cambia. Tampoco lo anticipa el guion.
      expect(deck.slice(0, deck.lastIndexOf("<section "))).not.toMatch(/\{\{gift/)
    }
  })

  it("la que reciben las clínicas también sale sin el guion", () => {
    const out = withoutGuide(withClinic(odentiaDeck, clinicSlide))
    expect(out).toContain('data-scene="clinic"')
    expect(out).not.toContain('<aside class="notes">')
  })

  it("no acepta una presentación sin esa parte", () => {
    expect(() => withClinic("<section></section>", clinicSlide)).toThrow("Tus agentes")
    // Ni una a la que le falte lo que la clínica se lleva.
    const short = '<section class="slide" aria-label="Tus agentes"></section>'
    expect(() => withClinic(short, clinicSlide)).toThrow("Mensajes fuera de horario")
  })
})

describe("la presentación que reciben las clínicas", () => {
  for (const [name, deck] of [
    ["odentIA", odentiaDeck],
    ["latidIA", latidiaDeck],
  ] as const) {
    it(`${name}: sale sin el guion ni su botón, con todas sus partes`, () => {
      const out = withoutGuide(deck)
      expect(deck).toContain('<aside class="notes">')
      expect(out).not.toContain('<aside class="notes">')
      expect(out).not.toContain("Guion (N)")
      expect(out).not.toContain('id="notesPanel"')
      expect(out.match(/<section class="slide"/g)?.length).toBe(
        deck.match(/<section class="slide"/g)?.length,
      )
      // El resto de los controles sigue.
      expect(out).toContain('id="next"')
      expect(out).toContain('id="full"')
    })
  }
})
