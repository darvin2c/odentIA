// Datos de la portada: los tres agentes, las siete vías por las que llega el trabajo
// y un jueves de ejemplo con 32 trabajos, uno por pieza dental. Todo es ejemplo.

/** `name` lleva el rol para cuando aparece solo; `short` es el nombre (Sofi, Clío, Argos; issue 183). */
export type Agent = { name: string; short: string; color: string; rgb: [number, number, number] }

export const AGENTS: Agent[] = [
  { name: "Sofi · recepción", short: "Sofi", color: "#4fc3d7", rgb: [0.31, 0.76, 0.84] },
  { name: "Clío · clínica", short: "Clío", color: "#a6f0d8", rgb: [0.65, 0.94, 0.85] },
  { name: "Argos · administración", short: "Argos", color: "#f5c46b", rgb: [0.96, 0.77, 0.42] },
]

export type Chan = { label: string; left: number; width: number; ax: number }

/** Los canales reales del producto, más la consulta, donde dicta el odontólogo (en coordenadas de la escena de 840 px). */
export const CHANS: Chan[] = (() => {
  const L = [
    "WhatsApp",
    "Instagram",
    "Messenger",
    "Telegram",
    "Chat web",
    "Correo",
    "En la consulta",
  ]
  const W = [92, 98, 100, 92, 92, 76, 132]
  let x = (840 - (W.reduce((a, b) => a + b, 0) + 8 * (W.length - 1))) / 2
  return L.map((label, i) => {
    const c = { label, left: x, width: W[i], ax: x + W[i] / 2 }
    x += W[i] + 8
    return c
  })
})()

export type DayEvent = {
  agent: number
  ch: number
  where: string
  out: string
  time: string
  text: string
  msg: string
}
export type Day = { ev: DayEvent[]; order: number[]; slotOf: number[] }

/** Un jueves de ejemplo: 32 trabajos, uno por pieza, cada uno con su canal, lo que cambió y su resultado. */
export const DAY: Day = (() => {
  const PAT = "DRRARDARRADRARDRARDRARDARRADRADR"
  const T: string[][][] = [
    [
      ["Agendó a {n} para el {d} a las {h}.", "Agenda", "cita", "«¿Tienen cita el {d}?»"],
      ["Le respondió a {n} el horario del sábado.", "", "", "«¿Atienden el sábado?»"],
      ["Movió la cita de {n} al {d}.", "Agenda", "cita", "«¿Puedo cambiar mi cita?»"],
      ["Le reenvió a {n} su presupuesto.", "Presupuestos", "", "«¿Me reenvían el presupuesto?»"],
      [
        "Pasó a recepción a {n}, que pidió hablar con una persona.",
        "Tareas",
        "tarea",
        "«Quiero hablar con alguien»",
      ],
      ["Agendó la primera consulta de {n}.", "Agenda", "cita", "«Quiero una evaluación»"],
    ],
    [
      ["La Dra. Paredes confirmó la nota de {n}.", "Historia", "nota", "La doctora dicta la nota"],
      ["El Dr. Ríos confirmó la nota de {n}.", "Historia", "nota", "El doctor dicta la nota"],
      ["Dejó listo el próximo control de {n}.", "Agenda", "cita", "«Control en seis meses»"],
    ],
    [
      ["Recordó la cita de {n} de las {h}.", "Agenda", "", "«Tu cita es hoy a las {h}»"],
      ["{n} volvió a su control.", "Agenda", "vuelta", "«Te toca tu control»"],
      [
        "Retomó el presupuesto de {n}, que lo aceptó.",
        "Presupuestos",
        "vuelta",
        "«¿Seguimos con tu tratamiento?»",
      ],
      ["Le ofreció otra fecha a {n}, que faltó ayer.", "Agenda", "cita", "«¿Te va bien el {d}?»"],
      ["Confirmó la cita de mañana de {n}.", "Agenda", "", "«¿Confirmas tu cita de mañana?»"],
    ],
  ]
  const RCH = [0, 1, 0, 2, 5, 4, 0, 3, 1, 0, 4, 0]
  const DCH = [0, 0, 5, 0, 3]
  const names = [
    "Andrea",
    "Carlos",
    "Rosa",
    "Jorge",
    "Miguel",
    "Lucía",
    "Pedro",
    "Valeria",
    "Diego",
    "Elena",
    "Raúl",
    "Martín",
    "Paula",
    "Tomás",
    "Inés",
    "Gabriel",
  ]
  const days = ["lunes", "martes", "miércoles", "viernes", "sábado"]
  const hours = ["9:00", "10:30", "12:00", "16:30", "18:00"]
  const used = [0, 0, 0]
  const ev: DayEvent[] = []
  for (let i = 0; i < 32; i++) {
    const a = "RAD".indexOf(PAT[i % PAT.length])
    const u = used[a]++
    const tp = T[a][u % T[a].length]
    const ch = a === 1 ? 6 : a === 0 ? RCH[u % RCH.length] : DCH[u % DCH.length]
    const m = Math.min(1367, 420 + Math.round((i * 947) / 31) + ((i * 13) % 9) - 4)
    const time = String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0")
    const fill = (x: string) =>
      x
        .replace("{n}", names[(i * 5 + 2) % names.length])
        .replace("{d}", days[(i * 3 + 1) % days.length])
        .replace("{h}", hours[i % hours.length])
    ev.push({ agent: a, ch, where: tp[1], out: tp[2], time, text: fill(tp[0]), msg: fill(tp[3]) })
  }
  let seed = 11
  const rnd = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const order = Array.from({ length: 32 }, (_, i) => i)
  for (let i = 31; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }
  const slotOf: number[] = []
  order.forEach((tooth, k) => {
    slotOf[tooth] = k
  })
  return { ev, order, slotOf }
})()

export function via(e: DayEvent): string {
  const l = CHANS[e.ch].label
  return e.ch === 6 ? "en la consulta" : (e.agent === 2 ? "por " : "desde ") + l
}

export function dir(e: DayEvent): string {
  return e.ch === 6
    ? "En la consulta"
    : (e.agent === 2 ? "Sale por " : "Entra por ") + CHANS[e.ch].label
}
