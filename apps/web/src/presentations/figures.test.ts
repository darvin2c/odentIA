import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { Pricing } from "../lib/pricing"
import { deckFigures, fillDeck, withClinic, withoutGuide } from "./figures"
import latidiaClinic from "./latidia/clinic-slide.html?raw"
import latidiaDeck from "./latidia/deck.html?raw"
import latidiaVoice from "./latidia/voz/guion.md?raw"
import odentiaClinic from "./odentia/clinic-slide.html?raw"
import odentiaDeck from "./odentia/deck.html?raw"
import odentiaVoice from "./odentia/voz/guion.md?raw"

describe("la v2, con la clínica en 3D", () => {
  const parts = (html: string) => html.match(/<section class="slide[^"]*" aria-label="[^"]*"/g)
  const names = (html: string) => parts(html)?.map((p) => p.split('aria-label="')[1].slice(0, -1))

  it("en odentIA lleva a la clínica lo que se ve pasar y deja aparte lo que hay que leer", () => {
    const out = withClinic(odentiaDeck, odentiaClinic, "dental")
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

  it("en latidIA lo mismo, y la urgencia y la receta quedan justo después de la clínica", () => {
    const out = withClinic(latidiaDeck, latidiaClinic, "medical")
    expect(names(out)).toEqual([
      "Lo que creemos",
      "Lo que hacemos",
      "Tus agentes",
      "Señales de alarma",
      "Receta y descanso médico",
      "Todo lo de siempre",
      "Solo cobramos por valor",
      "Tu semana con latidIA",
      "Tu precio",
      "Ser consultorio fundador",
    ])
    expect(out).toContain('data-scene="clinic"')
    // Sus escenas siguen en la presentación: no solo el texto.
    expect(out).toContain('data-scene="alarm"')
    expect(out).toContain('data-scene="rx"')
    expect(out).not.toContain('data-scene="notifs"')
  })

  for (const [name, slide, script, folder] of [
    ["odentIA", odentiaClinic, odentiaVoice, "voz"],
    ["latidIA", latidiaClinic, latidiaVoice, "voz-latidia"],
  ] as const) {
    it(`${name}: cada momento tiene su tema, con qué trabaja, su texto en el guion y su audio`, () => {
      const layers = slide.match(/<div class="layer[^>]*>/g) ?? []
      expect(layers.length).toBeGreaterThan(12)
      for (const layer of layers) {
        expect(layer).toMatch(/data-topic="[a-z]+"/)
        expect(layer).toMatch(/data-sc="(hoy|bot|crm|con)"/)
      }
      const keys = layers.map(
        (l) => `${/data-topic="(\w+)"/.exec(l)?.[1]}-${/data-sc="(\w+)"/.exec(l)?.[1]}`,
      )
      expect(slide).toContain(`data-voz="/presentacion/${folder}/"`)
      for (const key of keys) {
        expect(script.replaceAll("\r\n", "\n")).toContain(`## ${key}\n`)
        // Sin su audio ese momento se queda callado.
        expect(
          existsSync(new URL(`../../public/presentacion/${folder}/${key}.mp3`, import.meta.url)),
          key,
        ).toBe(true)
      }
      // Cada tema se puede ver como es hoy y con el producto; ninguno se repite.
      expect(new Set(keys).size).toBe(keys.length)
      for (const t of ["dia", "noche", "mostrador", "consulta", "fueron", "direccion"]) {
        expect(keys).toContain(`${t}-hoy`)
        expect(keys).toContain(`${t}-con`)
      }
    })
  }

  it("las dos clínicas tienen las mismas piezas: la escena es una sola", () => {
    const pieces = (slide: string) => {
      const found = slide.match(
        /data-(?:topic|sc|step|hold|hot|when|story|say|anchor|follow|show|live|name|field)="[^"]*"/g,
      )
      return [...new Set(found)].sort()
    }
    expect(pieces(latidiaClinic)).toEqual(pieces(odentiaClinic))
    for (const slide of [odentiaClinic, latidiaClinic]) {
      // Lo que la escena lee del momento: la hora de esa noche y cuántas notas quedaron.
      expect(slide).toMatch(/data-clock="\d\d:\d\d"/)
      expect(slide).toMatch(/data-big data-notes="\d+"/)
      expect(slide).toContain("data-done=")
    }
  })

  it("en latidIA nada es de odontología ni promete lo que latidIA no tiene", () => {
    // Las claves internas de la escena (data-story="unidad", por ejemplo) no se leen en pantalla.
    const shown = latidiaClinic.replace(/<[^>]+>/g, " ")
    expect(shown).not.toMatch(
      /odent|odont|muela|\bdiente|presupuesto|\bunidad\b|\b(?:la|tu|otra|una|esta) clínica\b|Dra\. Ana/i,
    )
    expect(latidiaClinic).not.toContain('data-screen="odontograma"')
    expect(shown).toContain("latidIA hace que pase")
    expect(shown).toContain("Dra. Vela")
  })

  it("cada ficha de la clínica abre una pantalla que existe en ese producto", () => {
    const screens = (slide: string) =>
      [...slide.matchAll(/data-screen="(\w+)"/g)].map((match) => match[1])
    expect(screens(odentiaClinic).length).toBeGreaterThan(0)
    for (const screen of screens(latidiaClinic)) {
      expect(latidiaDeck).toContain(`data-screen="${screen}"`)
    }
    for (const screen of screens(odentiaClinic)) {
      expect(odentiaDeck).toContain(`data-screen="${screen}"`)
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

  it("«Esto nunca se cobra» no incluye la conversación de quien reservó y no vino, que sí se cobra", () => {
    for (const deck of [odentiaDeck, latidiaDeck]) {
      const never = deck.slice(deck.indexOf('data-scene="never"'), deck.indexOf('id="nvTotal"'))
      expect(never.length).toBeGreaterThan(0)
      expect(never).not.toMatch(/no vino|sin asistencia/)
    }
  })

  it("con varios precios resalta el menor con «desde»", () => {
    for (const deck of [odentiaDeck, latidiaDeck]) {
      for (const mark of ["F.informa$", "L.informa$", "F.simple$", "L.simple$"]) {
        expect(deck).toContain(`<i class="from">desde</i> {{${mark}}}`)
      }
      expect(deck).not.toContain("{{F.informa}} · {{F.gestiona}} · {{F.agenda}}</span>")
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

  it("el botón del cierre es un enlace que lleva a pedir la invitación", () => {
    const plan = {
      currency: "USD",
      plan: 59,
      recovered: 2,
      tiers: { informa: 0.2, gestiona: 0.5, agenda: 1, simple: 0.1, estandar: 0.3, completa: 0.5 },
      trialCredit: 100,
      trialDays: 30,
      argos: null,
      storage: null,
    }
    const pricing = {
      list: plan,
      founders: { ...plan, plan: 0, discountPercent: 50, guaranteeMonths: 12 },
      signupMode: "invitacion",
      terms: { conversationWindowHours: 24, waitlistAnswerDays: 2 },
    } as unknown as Pricing
    const figures = deckFigures(pricing, ["gestiona"])
    expect(figures).not.toBeNull()
    for (const deck of [odentiaDeck, latidiaDeck]) {
      const out = fillDeck(deck, { ...figures, logo: "", ecg: "" })
      expect(out).toContain('<a class="btn" href="/solicitar-invitacion">Pide tus USD 100</a>')
      expect(out).not.toContain('<span class="btn">Pide tus')
    }
  })

  it("la que reciben las clínicas también sale sin el guion", () => {
    for (const out of [
      withClinic(odentiaDeck, odentiaClinic, "dental"),
      withClinic(latidiaDeck, latidiaClinic, "medical"),
    ]) {
      const sent = withoutGuide(out)
      expect(sent).toContain('data-scene="clinic"')
      expect(sent).not.toContain('<aside class="notes">')
    }
  })

  it("no acepta una presentación sin esa parte", () => {
    expect(() => withClinic("<section></section>", odentiaClinic, "dental")).toThrow("Tus agentes")
    // Ni una a la que le falte lo que la clínica se lleva, o lo que va justo después.
    const short = '<section class="slide" aria-label="Tus agentes"></section>'
    expect(() => withClinic(short, odentiaClinic, "dental")).toThrow("Mensajes fuera de horario")
    expect(() => withClinic(short, latidiaClinic, "medical")).toThrow("Señales de alarma")
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
