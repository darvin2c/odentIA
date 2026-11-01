import { describe, expect, it } from "vitest"
import { createSim } from "./clinic-sim.js"
import slide from "./clinic-slide.html?raw"

type Person = {
  active: boolean
  kind: string
  state: string
  x: number
  z: number
  path: unknown[]
}

const clients = (sim: ReturnType<typeof createSim>) =>
  sim.people.filter((p: Person) => p.kind === "cliente" && p.active)

describe("la clínica simulada de la v2", () => {
  it("sin odentIA llega mucha gente y se le pierde a la clínica", () => {
    const sim = createSim()
    sim.advance(150)
    const { llegaron, atendidos, fueron } = sim.counts
    expect(llegaron).toBeGreaterThan(60)
    expect(fueron).toBeGreaterThan(atendidos)
    // Algo atiende: es un equipo que no da abasto, no una clínica cerrada.
    expect(atendidos).toBeGreaterThan(4)
    expect(sim.counts.sinResponder).toBeGreaterThan(3)
    // Se ve mucha gente a la vez, no una sola paciente.
    expect(clients(sim).length).toBeGreaterThan(30)
  })

  it("con odentIA llega la misma gente, pero casi nadie se va", () => {
    const sin = createSim()
    sin.advance(120)
    const antes = sin.counts.fueron
    sin.withAgents()
    const llegaronAntes = sin.counts.llegaron
    sin.advance(120)
    // La demanda no se inventa: sigue llegando parecido.
    expect(sin.counts.llegaron - llegaronAntes).toBeGreaterThan(45)
    expect(sin.counts.fueron - antes).toBeLessThan(14)
    expect(sin.counts.atendidos).toBeGreaterThan(sin.counts.fueron - antes)
    expect(sin.counts.sinResponder).toBe(0)
  })

  it("recupera a parte de los que se fueron, no a todos", () => {
    const sim = createSim()
    sim.advance(150)
    sim.withAgents()
    sim.startRecovery()
    sim.advance(100)
    expect(sim.counts.volvieron).toBeGreaterThan(3)
    expect(sim.counts.noVuelven).toBeGreaterThan(0)
  })

  it("con odentIA la fila y la sala se vacían: nadie se queda esperando", () => {
    const sim = createSim()
    sim.advance(120)
    const filaAntes = sim.counts.fila
    sim.withAgents()
    sim.advance(60)
    expect(sim.counts.fila).toBeLessThan(filaAntes)
    expect(sim.counts.fila).toBeLessThanOrEqual(3)
    expect(sim.counts.sala).toBeLessThanOrEqual(4)
    // Lo de antes queda guardado para comparar, y nunca se atiende a más gente de la que llegó.
    expect(sim.antes.fueron).toBeGreaterThan(5)
    const llegaron = sim.counts.llegaron - sim.antes.llegaron + sim.antes.enEspera
    expect(sim.counts.atendidos - sim.antes.atendidos).toBeLessThanOrEqual(llegaron)
  })

  it("con un chatbot responde al instante, pero nadie busca a los que se fueron", () => {
    const hoy = createSim()
    hoy.advance(150)
    const bot = createSim()
    bot.setFlavor("bot")
    bot.advance(150)
    // Los mensajes pesan menos que hoy, y aun así la gente se va y la agenda no se llena sola.
    expect(bot.counts.sinResponder).toBeLessThan(hoy.counts.sinResponder + 8)
    expect(bot.counts.fueron).toBeGreaterThan(5)
    expect(bot.counts.agendados).toBe(0)
    expect(bot.counts.volvieron).toBe(0)
  })

  it("con un CRM los que se fueron quedan anotados, y nadie les escribe", () => {
    const sim = createSim()
    sim.setFlavor("crm")
    sim.advance(170)
    expect(sim.counts.pendientes).toBeGreaterThan(5)
    expect(sim.counts.volvieron).toBe(0)
    const lost = sim.people.filter((p: Person) => p.active && p.state === "perdido")
    expect(lost.length).toBeGreaterThan(5)
    for (const p of lost) expect(p.story).toBe("crm-anotado")
  })

  it("de noche se va el equipo y nadie entra; sin agentes los mensajes se quedan", () => {
    const sim = createSim()
    sim.advance(60)
    const antes = sim.counts.sinResponder
    const fueron = sim.counts.fueron
    sim.closeNow()
    sim.advance(40)
    expect(sim.night).toBe(true)
    expect(sim.counts.fila).toBe(0)
    expect(sim.counts.sala).toBe(0)
    for (const k of ["recep", "caja", "doctora", "director"]) expect(sim.team[k].active).toBe(false)
    expect(sim.counts.sinResponder).toBeGreaterThan(antes)
    expect(sim.counts.fueron).toBeGreaterThan(fueron)
  })

  it("de noche Sofi responde y agenda; al amanecer el equipo vuelve a su puesto", () => {
    const sim = createSim()
    sim.advance(60)
    sim.closeNow()
    sim.withAgents()
    const agendados = sim.counts.agendados
    sim.advance(40)
    expect(sim.counts.agendados).toBeGreaterThan(agendados + 5)
    expect(sim.counts.sinResponder).toBe(0)
    sim.dawn()
    expect(sim.night).toBe(false)
    sim.advance(30)
    for (const k of ["recep", "caja", "doctora", "director"]) {
      expect(sim.team[k].active).toBe(true)
      expect(sim.team[k].away).toBe(false)
    }
  })

  it("toda persona que se puede tocar tiene su ficha, en todo momento", () => {
    const seen = new Set<string>()
    const run = (setup: (s: ReturnType<typeof createSim>, i: number) => void) => {
      const sim = createSim()
      for (let i = 0; i < 2200; i++) {
        setup(sim, i)
        sim.step(0.1)
        for (const p of sim.people) if (p.active && p.kind === "cliente") seen.add(p.story)
      }
    }
    run((s, i) => {
      if (i === 900) s.withAgents()
      if (i === 1400) s.startRecovery()
    })
    run((s, i) => {
      if (i === 0) s.setFlavor("bot")
    })
    run((s, i) => {
      if (i === 0) s.setFlavor("crm")
    })
    run((s, i) => {
      if (i === 500) s.closeNow()
      if (i === 900) s.withAgents()
      if (i === 1400) s.dawn()
    })
    expect(seen.size).toBeGreaterThan(20)
    for (const story of seen) expect(slide, story).toContain(`data-story="${story}"`)
  })

  it("no muestra llamadas: odentIA no las resuelve", () => {
    expect(slide).not.toMatch(/teléfono|llamadas?\b/i)
    const sim = createSim()
    sim.advance(120)
    for (const p of sim.people) expect(p.channel).not.toBe("llamada")
  })

  it("con el mismo azar da lo mismo, también después de reiniciar", () => {
    const a = createSim(5)
    a.advance(60)
    const first = { ...a.counts }
    a.reset()
    a.advance(60)
    expect({ ...a.counts }).toEqual(first)
  })

  it("nadie se queda varado: en un rato largo nadie queda fuera de la planta ni el conteo se rompe", () => {
    const sim = createSim()
    sim.advance(200)
    sim.withAgents()
    sim.startRecovery()
    sim.advance(300)
    for (const p of sim.people.filter((q: Person) => q.active)) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.z)).toBe(true)
      expect(p.x).toBeGreaterThan(-20)
      expect(p.x).toBeLessThan(14)
    }
    // El grupo sigue vivo: no se agotaron las personas.
    expect(clients(sim).length).toBeLessThan(110)
  })
})
