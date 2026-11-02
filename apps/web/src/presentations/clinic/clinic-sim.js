// Lo que pasa en la clínica de la v2, sin dibujar nada: quién llega, quién espera, a quién se atiende
// y quién se va. clinic-3d.js lo dibuja y clinic-slide.html dice lo que se lee: aquí solo hay claves.
//
// La demanda es la misma con y sin odentIA: llega la misma gente. Lo que cambia es qué le pasa. Es una
// simulación de ejemplo con azar fijo, no los datos de ninguna clínica, y la pantalla lo dice.

const PI = Math.PI

/* ===== La planta ===== */
const FRENTE = [0, 4.6]
const PUERTA = [0, 3.55]
const LOBBY = [-0.2, 2.75]
const LADO_SALA = [-4.3, 1.95]
const CONS_A = [1.75, 1.55]
const CONS_B = [1.75, 0.35]
const UNIDAD_LADO = [3.6, -0.35]
const SALIDA = [11, 5.8]
const ENTRA_IZQ = [-15.5, 4.3]
const ENTRA_DER = [11, 4.7]
const FUERA_DE_CUADRO = [-1, 13.5]
const ARCHIVO = [-5.3, -3.62]
const RUTA_ARCHIVO = [[-0.9, -0.1], [-0.9, -1.75], [-2.2, -1.8], [-5.3, -1.9], ARCHIVO]
/** Por dónde se va cada quien al cerrar; al día siguiente vuelve por el mismo camino. */
const RUTA_SALIDA = {
  recep: [[-0.62, -0.15], [-0.25, 1.35], LOBBY, PUERTA, FRENTE, SALIDA],
  caja: [[2.3, 1.7], [1.35, 2.7], PUERTA, FRENTE, SALIDA],
  doctora: [[1.75, -0.45], CONS_B, CONS_A, [0.8, 2.6], PUERTA, FRENTE, SALIDA],
  director: [
    [-2.4, -3.5],
    [-0.9, -2.2],
    [-0.62, -0.15],
    [-0.25, 1.35],
    LOBBY,
    PUERTA,
    FRENTE,
    SALIDA,
  ],
}
const RUTA_FICHA = [[1.75, -0.45], CONS_B, CONS_A, [-0.45, 1.55]]

/** De la cabeza de la fila hacia afuera: cuando crece, sale por la puerta y sigue en la calle. */
const FILA = [
  [-2.4, 1.72],
  [-1.85, 2.05],
  [-1.3, 2.35],
  [-0.75, 2.65],
  [-0.25, 3.0],
  [0, 3.5],
  [0.05, 4.05],
  [0.3, 4.55],
  [0.7, 5.0],
  [1.2, 5.35],
  [1.8, 5.6],
]
const FILA_DENTRO = 6
const FILA_CAJA = [
  [3.7, 3.12],
  [2.95, 3.15],
  [2.3, 3.15],
  [1.7, 3.15],
]
const ASIENTOS = [
  [-5.4, 0.5, PI / 2],
  [-5.4, 1.3, PI / 2],
  [-5.4, 2.1, PI / 2],
  [-4.6, 3.1, PI],
  [-3.8, 3.1, PI],
  [-3.0, 3.1, PI],
].map(([x, z, yaw]) => ({ x, z, yaw, sit: true, p: null }))
const DE_PIE = [
  [-4.5, 1.65],
  [-3.85, 2.2],
  [-4.65, 2.4],
  [-3.2, 2.45],
  [-2.6, 2.75],
].map(([x, z]) => ({ x, z, yaw: 2.2, sit: false, p: null }))
const CALLE = []
for (let i = 0; i < 19; i++) {
  const x = -6.7 + i * 0.72
  if (x > -0.8 && x < 2.3) continue
  CALLE.push({ x, z: 4.75 + ((i * 7) % 4) * 0.56, p: null })
}
/** Los que se fueron cruzan la calle y quedan ahí, a la vista. Cuando no caben, siguen de largo y salen de cuadro. */
const PERDIDOS = []
for (let r = 0; r < 5; r++) {
  for (let c = 0; c < 10; c++) {
    PERDIDOS.push({
      x: 1.2 - c * 0.62 - (r % 2) * 0.28,
      z: 7.95 + r * 0.55 + Math.sin(c * 2.1 + r) * 0.1,
      p: null,
    })
  }
}

export const UNIDAD = { x: 4.42, y: 0.57, z: -1.4, lean: 1.3 }
export const EQUIPO = {
  recep: { x: -2.4, z: 0.02, yaw: 0 },
  caja: { x: 3.7, z: 1.72, yaw: 0 },
  doctora: { x: 2.25, z: -1.78, yaw: 1.15 },
  director: { x: -3.8, z: -3.42, yaw: 0 },
}
/** Con un CRM cada cosa vive en su pantalla, y nada pasa de una a otra sin que alguien la copie. */
export const PANTALLAS = {
  mensajes: { x: -4.85, z: -0.35 },
  agenda: { x: -0.2, z: -0.62 },
  historia: { x: 1.55, z: -3.0 },
  caja: { x: 5.4, z: 1.62 },
}
export const AGENDA_HUECOS = 15
const CLIENTES = 110

function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const angleTo = (cur, tar, rate, dt) => {
  const d = Math.atan2(Math.sin(tar - cur), Math.cos(tar - cur))
  return cur + d * (1 - Math.exp(-rate * dt))
}

export function createSim(seed = 11) {
  let rand = prng(seed)
  const between = (a, b) => a + rand() * (b - a)
  const chance = (x) => rand() < x

  const people = []
  /** @type {Record<string, ReturnType<typeof blank> & Record<string, any>>} */
  const team = {}
  let mode = "sin"
  /** Sin agentes, con qué trabaja la clínica: «hoy», «bot» o «crm». */
  let flavor = "hoy"
  let night = false
  let recovering = false
  let time = 0
  let spawnIn = 0
  let recoverIn = 0
  let citaIn = 0
  let clearing = 0
  let scheduled = 0
  let nextName = 0
  let unitP = null
  let antes = null
  let events = []
  let fila = []
  let filaCaja = []
  let sala = []
  const counts = {
    llegaron: 0,
    atendidos: 0,
    fueron: 0,
    volvieron: 0,
    noVuelven: 0,
    sinResponder: 0,
    agendados: 0,
    pendientes: 0,
    fila: 0,
    sala: 0,
  }

  const emit = (type, p = null) => events.push({ type, p })
  const freeSlots = (list) => {
    for (const s of list) s.p = null
  }

  /* ----- Personas ----- */
  function blank(i, kind) {
    return {
      id: i,
      kind,
      active: false,
      x: 0,
      z: 0,
      y: 0,
      lean: 0,
      yaw: 0,
      face: 0,
      path: [],
      speed: 1.5,
      walking: false,
      pose: "stand",
      bubble: null,
      state: "",
      next: "",
      t: 0,
      since: 0,
      patience: Number.POSITIVE_INFINITY,
      story: "",
      dim: 0,
      slot: null,
      channel: "",
      name: 0,
      look: i,
      declined: false,
      born: 0,
      warp: 0,
    }
  }
  function reset() {
    rand = prng(seed)
    mode = "sin"
    flavor = "hoy"
    night = false
    recovering = false
    time = 0
    spawnIn = 0
    recoverIn = 0
    citaIn = 0
    clearing = 0
    scheduled = 0
    nextName = 0
    unitP = null
    antes = null
    events = []
    fila = []
    filaCaja = []
    sala = []
    for (const k of Object.keys(counts)) counts[k] = 0
    for (const list of [ASIENTOS, DE_PIE, CALLE, PERDIDOS]) freeSlots(list)
    people.length = 0
    for (let i = 0; i < CLIENTES; i++) people.push(blank(i, "cliente"))
    let i = CLIENTES
    for (const key of Object.keys(EQUIPO)) {
      const home = EQUIPO[key]
      const p = blank(i++, "equipo")
      Object.assign(p, {
        key,
        active: true,
        x: home.x,
        z: home.z,
        yaw: home.yaw,
        face: home.yaw,
        pose: "sitSlump",
        task: "idle",
        speed: 2,
        away: false,
        leaving: false,
        returning: false,
      })
      team[key] = p
      people.push(p)
    }
  }
  function take() {
    const p = people.find((q) => q.kind === "cliente" && !q.active)
    if (!p) return null
    const name = nextName++
    Object.assign(p, blank(p.id, "cliente"), {
      active: true,
      name,
      look: p.id,
      born: time,
      since: time,
      warp: (p.warp || 0) + 1,
      speed: between(1.35, 1.75),
    })
    counts.llegaron++
    return p
  }
  const walk = (p, path, next, speed) => {
    p.path = path.map((w) => [w[0], w[1]])
    p.next = next
    p.state = "camino"
    if (speed) p.speed = speed
  }
  const become = (p, state, t = 0) => {
    p.state = state
    p.t = t
    p.since = time
  }
  const release = (p) => {
    if (p.slot) p.slot.p = null
    p.slot = null
  }
  const pickSlot = (list, p) => {
    const free = list.filter((s) => !s.p)
    if (!free.length) return null
    const s = free[Math.floor(rand() * Math.min(free.length, 6))]
    s.p = p
    p.slot = s
    return s
  }

  /* ----- La fila del mostrador ----- */
  function routeToFila(p, j) {
    const s = FILA[j]
    p.filaAt = j
    p.path = p.z > 3.7 && j < FILA_DENTRO ? [FRENTE, PUERTA, s].map((w) => [...w]) : [[...s]]
    p.next = "fila"
    p.state = "camino"
  }
  function reflow() {
    fila.forEach((p, j) => {
      if (p.filaAt !== j) routeToFila(p, j)
    })
    filaCaja.forEach((p, j) => {
      if (p.cajaAt !== j) {
        p.cajaAt = j
        walk(p, [FILA_CAJA[Math.min(j, FILA_CAJA.length - 1)]], "filaCaja")
      }
    })
  }
  const dropFromLists = (p) => {
    fila = fila.filter((q) => q !== p)
    sala = sala.filter((q) => q !== p)
    p.filaAt = undefined
    reflow()
  }

  /* ----- Se cansan y se van ----- */
  function harto(p, story) {
    dropFromLists(p)
    release(p)
    p.story = story
    p.bubble = "x"
    p.pose = "armsUp"
    p.path = []
    p.walking = false
    counts.fueron++
    emit("fue", p)
    become(p, "harto", 1.25)
  }
  function goLost(p) {
    const slot = PERDIDOS.find((s) => !s.p)
    const inside = p.z < 3.6
    const route = []
    if (inside) {
      if (p.x < -3.2) route.push(LADO_SALA)
      route.push(LOBBY, PUERTA, FRENTE)
    }
    p.bubble = null
    p.pose = "stand"
    if (slot) {
      slot.p = p
      p.slot = slot
      route.push([slot.x, slot.z])
      walk(p, route, "perdido", between(1.9, 2.3))
    } else {
      route.push(FUERA_DE_CUADRO)
      walk(p, route, "fuera", between(1.9, 2.3))
    }
  }

  /* ----- Llegan ----- */
  function arrival() {
    // La misma gente: con quien responde mensajes, menos personas tienen que venir a preguntar.
    if (!night && chance(mode === "sin" ? 0.42 : 0.22)) walkIn(false)
    else messageIn()
  }
  function spawnPoint(p) {
    const [x, z] = chance(0.55) ? ENTRA_IZQ : ENTRA_DER
    p.x = x
    p.z = z + between(-0.2, 0.2)
    p.yaw = x < 0 ? PI / 2 : -PI / 2
    p.face = p.yaw
  }
  function walkIn(cita, returning = false) {
    if (fila.length >= FILA.length) {
      if (mode !== "sin") return
      const p = take()
      if (!p) return
      spawnPoint(p)
      p.story = "fila-llena"
      p.channel = "puerta"
      walk(p, [FRENTE], "ve-fila")
      return
    }
    const p = returning || cita ? takeUncounted() : take()
    if (!p) return
    spawnPoint(p)
    p.channel = "puerta"
    p.cita = cita
    p.story = cita ? (returning ? "vuelve" : "cita") : mode === "sin" ? "fila" : "fila-con"
    p.patience = mode === "sin" ? between(20, 38) : Number.POSITIVE_INFINITY
    fila.push(p)
    routeToFila(p, fila.length - 1)
  }
  function takeUncounted() {
    const p = take()
    if (p) counts.llegaron--
    return p
  }
  function messageIn() {
    const p = take()
    if (!p) return
    spawnPoint(p)
    const slot = pickSlot(CALLE, p)
    if (!slot) {
      counts.llegaron--
      p.active = false
      return
    }
    p.channel = "mensaje"
    p.story = mode === "sin" ? (night ? "noche" : "mensaje") : night ? "noche-con" : "mensaje-con"
    walk(p, [[slot.x, slot.z]], "escribe")
  }

  /* ----- Sofi responde ----- */
  function answerBySofi(p) {
    emit("respuesta", p)
    p.bubble = "sofi"
    p.story = p.story === "vuelta-msg" ? "vuelve" : night ? "noche-con" : "mensaje-con"
    become(p, "sofiEscribe", between(0.7, 1.1))
  }
  function booked(p) {
    p.bubble = "cal"
    p.story = p.story === "vuelve" ? "vuelve" : night ? "noche-agendado" : "agendado"
    counts.agendados++
    emit("agenda", p)
    become(p, "agendado", 1.25)
  }
  function leaveHappy(p) {
    release(p)
    p.bubble = "smile"
    p.pose = "stand"
    // Desde adentro se sale por la puerta; desde la calle, por la calle.
    if (p.z < 3.6) walk(p, [LOBBY, PUERTA, FRENTE, SALIDA], "fuera")
    else walk(p, [[p.x + 0.4, Math.min(p.z + 0.1, 6.9)], SALIDA], "fuera")
  }

  /* ----- El equipo ----- */
  function headOfFila() {
    const p = fila[0]
    return p && p.state === "fila" && p.filaAt === 0 ? p : null
  }
  function nextRecep(r) {
    r.serving = null
    const head = headOfFila()
    if (mode === "sin") {
      if (head && chance(0.62)) return serve(r, head, between(3.8, 5.6))
      const roll = rand()
      if (flavor === "crm" && roll < 0.4) {
        r.task = "camino"
        r.pose = "stand"
        r.path = [[-4.35, 0.02]]
        r.next = "pantalla1"
        return
      }
      if (roll < 0.45 && people.some((q) => q.active && q.state === "escribe")) {
        r.task = "whatsapp"
        r.t = between(4, 6.5)
        r.pose = "phoneSit"
        return
      }
      if (roll < 0.66) {
        r.task = "busca"
        r.pose = "stand"
        r.path = RUTA_ARCHIVO.map((w) => [...w])
        r.next = "archivo"
        return
      }
      if (roll < 0.84) {
        r.task = "agobio"
        r.t = between(2.2, 3.4)
        r.pose = "headHands"
        return
      }
      r.task = "copia"
      r.t = between(3, 4.5)
      r.pose = "type"
      return
    }
    if (head) return serve(r, head, between(1.4, 2))
    r.task = "copia"
    r.t = fila.length ? 0.2 : between(1, 2)
    r.pose = "typeCalm"
  }
  function serve(r, p, t) {
    r.task = "serve"
    r.t = t
    r.pose = mode === "sin" ? "talk" : "talkCalm"
    r.serving = p
    p.state = "atendiendo"
    p.bubble = null
    p.pose = "stand"
    p.face = PI
  }
  function finishServe(p) {
    fila = fila.filter((q) => q !== p)
    p.filaAt = undefined
    if (!p.cita) counts.atendidos++
    reflow()
    if (mode !== "sin" && !p.cita && sala.length >= 2) {
      p.story = "agendado"
      booked(p)
      return
    }
    const seat = pickSeat(p)
    p.story = mode === "sin" ? "sala" : p.cita ? p.story : "sala-con"
    p.patience = mode === "sin" ? between(26, 46) : Number.POSITIVE_INFINITY
    sala.push(p)
    if (!seat) {
      // Sin sitio se queda en el vestíbulo, de pie.
      walk(p, [LOBBY], "sala")
      return
    }
    walk(p, [LADO_SALA, [seat.x, seat.z]], "sala")
    if (seat.x > -4.2 && seat.z > 2.2) p.path.shift()
  }
  function pickSeat(p) {
    const s = ASIENTOS.find((a) => !a.p) ?? DE_PIE.find((a) => !a.p)
    if (!s) return null
    s.p = p
    p.slot = s
    return s
  }
  function stepRecep(r, dt) {
    if (r.path.length) return
    if (r.next === "archivo") {
      r.next = ""
      r.task = "archivo"
      r.t = between(1.4, 2.2)
      r.pose = "armsHead"
      r.face = PI
      return
    }
    if (r.next === "silla") {
      r.next = ""
      Object.assign(r, { x: EQUIPO.recep.x, z: EQUIPO.recep.z, face: 0 })
      nextRecep(r)
      return
    }
    if (r.next === "pantalla1" || r.next === "pantalla2") {
      r.task = r.next
      r.next = ""
      r.t = between(1.1, 1.6)
      r.pose = "typeStand"
      r.face = r.task === "pantalla1" ? -2.3 : 2.7
      return
    }
    r.t -= dt
    if (r.t > 0) return
    if (r.task === "pantalla1") {
      r.pose = "stand"
      r.task = "camino"
      r.path = [[-0.62, -0.15]]
      r.next = "pantalla2"
      return
    }
    if (r.task === "pantalla2") {
      r.pose = "stand"
      r.task = "vuelve"
      r.path = [[EQUIPO.recep.x, EQUIPO.recep.z]]
      r.next = "silla"
      return
    }
    if (r.task === "archivo") {
      r.pose = "stand"
      r.task = "vuelve"
      r.path = [...RUTA_ARCHIVO].reverse().slice(1)
      r.path.push([EQUIPO.recep.x, EQUIPO.recep.z])
      r.path = r.path.map((w) => [...w])
      r.next = "silla"
      return
    }
    if (r.task === "serve" && r.serving) {
      finishServe(r.serving)
      if (flavor === "crm" && mode === "sin") {
        // Lo que acaba de pasar hay que escribirlo: el CRM no se entera solo.
        r.serving = null
        r.task = "registra"
        r.t = between(2.4, 3.8)
        r.pose = "type"
        return
      }
    }
    if (r.task === "whatsapp" && mode === "sin") answerLate()
    r.face = 0
    nextRecep(r)
  }
  function answerLate() {
    const p = people.find((q) => q.active && q.state === "escribe")
    if (!p) return
    counts.atendidos++
    counts.sinResponder = Math.max(0, counts.sinResponder - 1)
    emit("tarde", p)
    p.story = "tarde"
    p.bubble = "check"
    become(p, "respondida", 1.1)
  }
  function stepDoctora(d, dt) {
    if (d.path.length) return
    if (d.next === "mostrador") {
      d.next = ""
      d.task = "pregunta"
      d.t = between(1.6, 2.4)
      d.pose = "talk"
      d.face = PI
      return
    }
    if (d.next === "silla") {
      d.next = ""
      Object.assign(d, { x: EQUIPO.doctora.x, z: EQUIPO.doctora.z, face: EQUIPO.doctora.yaw })
      d.task = "libre"
    }
    if (d.task === "pregunta") {
      d.t -= dt
      if (d.t <= 0) {
        d.pose = "stand"
        d.path = [...RUTA_FICHA]
          .reverse()
          .slice(1)
          .concat([[EQUIPO.doctora.x, EQUIPO.doctora.z]])
        d.path = d.path.map((w) => [...w])
        d.next = "silla"
      }
      return
    }
    if (d.task === "nota") {
      d.t -= dt
      d.pose = "headHands"
      if (d.t <= 0) d.task = "libre"
      return
    }
    if (d.task === "libre" || d.task === "idle") {
      d.pose = mode === "sin" ? "sitSlump" : "calmSit"
      d.face = EQUIPO.doctora.yaw
      if (!unitP && sala.length) {
        const p = sala.find((q) => q.state === "sala")
        if (p) callToUnit(p)
      }
    }
  }
  function callToUnit(p) {
    sala = sala.filter((q) => q !== p)
    release(p)
    reflow()
    unitP = p
    p.bubble = null
    p.pose = "stand"
    const route = []
    if (p.x < -3.2) route.push(LADO_SALA)
    route.push(LOBBY, CONS_A, CONS_B, UNIDAD_LADO, [UNIDAD.x, UNIDAD.z])
    walk(p, route, "unidad")
    team.doctora.task = "espera"
    team.doctora.pose = "sit"
  }
  function stepCaja(c, dt) {
    const head = filaCaja[0]
    if (c.task === "cobra") {
      c.t -= dt
      if (c.t <= 0 && c.payer) {
        const p = c.payer
        c.payer = null
        c.task = "idle"
        filaCaja = filaCaja.filter((q) => q !== p)
        p.cajaAt = undefined
        reflow()
        p.bubble = mode === "sin" ? null : "smile"
        p.story = mode === "sin" ? "sale" : "sale-con"
        walk(p, [[1.2, 3.1], PUERTA, [0.5, 4.6], SALIDA], "fuera")
      }
      return
    }
    if (head && head.state === "filaCaja" && head.cajaAt === 0) {
      c.task = "cobra"
      c.t = mode === "sin" ? between(4.5, 6.5) : between(2.2, 3)
      c.pose = "talkCalm"
      c.payer = head
      head.state = "pagando"
      head.face = PI
      return
    }
    c.t -= dt
    if (c.t <= 0) {
      c.t = between(3, 6)
      c.pose = mode === "sin" ? (chance(0.5) ? "headHands" : "type") : "typeCalm"
    }
  }
  function stepDirector(d, dt) {
    if (d.path.length) return
    d.t -= dt
    if (mode !== "sin") {
      if (d.task !== "calma" && !d.next) {
        d.task = "calma"
        d.pose = "stand"
        d.path = [[EQUIPO.director.x, EQUIPO.director.z]]
        d.next = "silla"
        return
      }
      if (d.next === "silla") {
        d.next = ""
        d.face = 0
      }
      d.pose = "calmSit"
      return
    }
    if (d.next === "agenda") {
      d.next = ""
      d.task = "agenda"
      d.t = between(2.2, 3.4)
      d.pose = "armsHead"
      d.face = PI
      return
    }
    if (d.next === "silla") {
      d.next = ""
      d.task = "reporte"
      d.t = between(4, 7)
      d.pose = "headHands"
      d.face = 0
      return
    }
    if (d.t > 0) return
    if (d.task === "agenda") {
      d.pose = "stand"
      d.path = [[EQUIPO.director.x, EQUIPO.director.z]]
      d.next = "silla"
      return
    }
    d.pose = "stand"
    d.path = [[-2.6, -3.72]]
    d.next = "agenda"
  }

  /* ----- Cada persona en su estado ----- */
  function arrive(p) {
    const next = p.next
    p.next = ""
    p.walking = false
    switch (next) {
      case "escribe":
        become(p, "escribe")
        p.face = 0.4
        p.pose = "phone"
        if (mode !== "sin") {
          p.bubble = null
          p.answerAt = time + between(0.4, 1)
          emit("mensajeCon", p)
        } else if (flavor === "bot") {
          p.bubble = "bot"
          p.story = "bot-responde"
          emit("botResponde", p)
          become(p, "botEscribe", between(0.9, 1.5))
        } else {
          p.bubble = "msg"
          counts.sinResponder++
          emit("mensaje", p)
          p.patience = night ? between(9, 17) : between(16, 30)
        }
        break
      case "fila":
        p.state = "fila"
        p.face = p.filaAt === 0 ? PI : -2.4
        p.pose = mode === "sin" ? "waitTap" : "stand"
        break
      case "ve-fila":
        harto(p, "fila-llena")
        break
      case "sala":
        p.state = "sala"
        p.since = time
        if (p.slot) {
          p.x = p.slot.x
          p.z = p.slot.z
          p.face = p.slot.yaw
          p.pose = p.slot.sit ? (mode === "sin" ? "sitSlump" : "sit") : "waitTap"
        } else {
          p.pose = "waitTap"
        }
        break
      case "unidad":
        Object.assign(p, {
          x: UNIDAD.x,
          z: UNIDAD.z,
          y: UNIDAD.y,
          lean: UNIDAD.lean,
          face: 0,
          pose: "lie",
        })
        p.story = mode === "sin" ? "unidad" : "unidad-con"
        become(p, "tratamiento", mode === "sin" ? between(8, 10) : between(6, 7.5))
        team.doctora.task = "trata"
        team.doctora.pose = "treat"
        team.doctora.face = EQUIPO.doctora.yaw
        break
      case "filaCaja":
        p.state = "filaCaja"
        p.pose = "stand"
        p.face = p.cajaAt === 0 ? PI : 1.6
        break
      case "perdido":
        p.state = "perdido"
        p.pose = "lost"
        p.dim = 0.6
        p.face = 0.35
        p.since = time
        if (flavor === "crm" && mode === "sin") {
          // Queda anotado. Eso es todo lo que pasa.
          p.bubble = "note"
          p.story = "crm-anotado"
          counts.pendientes++
        }
        break
      case "fuera":
        release(p)
        p.active = false
        break
      default:
        break
    }
  }
  function stepClient(p, dt) {
    switch (p.state) {
      case "escribe":
        if (mode !== "sin") {
          if (p.answerAt === undefined) p.answerAt = time + between(0.2, 3.2)
          if (time >= p.answerAt) {
            if (p.bubble === "msg") p.bubble = null
            answerBySofi(p)
          }
        } else if (time - p.since > p.patience) {
          const was = p.story
          harto(
            p,
            was === "bot-espera" ? "bot-perdido" : night ? "noche-perdido" : "mensaje-perdido",
          )
        }
        break
      case "botEscribe":
        p.t -= dt
        if (p.t <= 0) {
          // Lo que sabe, lo responde; agendar y lo demás le queda al equipo.
          if (chance(0.25)) {
            counts.atendidos++
            p.story = "bot-resuelto"
            p.bubble = "check"
            become(p, "respondida", 1.1)
          } else {
            counts.sinResponder++
            p.story = "bot-espera"
            p.bubble = "wait"
            p.patience = between(14, 26)
            become(p, "escribe")
          }
        }
        break
      case "sofiEscribe":
        p.t -= dt
        if (p.t <= 0) {
          // No todos toman la hora: unos pocos no siguen la conversación.
          if (p.story !== "vuelve" && chance(0.05)) {
            harto(p, "no-quiso")
            break
          }
          if (p.story !== "vuelve") counts.atendidos++
          booked(p)
        }
        break
      case "agendado":
        p.t -= dt
        if (p.t <= 0) {
          if (p.story === "vuelve" && fila.length + sala.length < 4) {
            p.bubble = "check"
            p.cita = true
            p.patience = Number.POSITIVE_INFINITY
            fila.push(p)
            routeToFila(p, fila.length - 1)
            break
          }
          scheduled++
          leaveHappy(p)
        }
        break
      case "respondida":
        p.t -= dt
        if (p.t <= 0) {
          scheduled += mode === "sin" ? 0 : 1
          leaveHappy(p)
          p.bubble = null
        }
        break
      case "fila":
        if (mode === "sin") {
          p.bubble = time - p.since > 4 ? "wait" : null
          if (time - p.born > p.patience + 8 && p.filaAt > 0) harto(p, "fila-perdido")
        } else {
          if (p.bubble === "wait") p.bubble = null
          if (p.answerAt !== undefined && time >= p.answerAt && p.filaAt > 0) {
            p.answerAt = undefined
            dropFromLists(p)
            p.path = []
            p.pose = "phone"
            answerBySofi(p)
          }
        }
        break
      case "sala":
        if (mode === "sin") {
          p.bubble = time - p.since > 5 ? "wait" : null
          if (time - p.since > p.patience) harto(p, "sala-perdido")
        } else if (p.bubble === "wait") {
          p.bubble = null
        }
        break
      case "tratamiento":
        p.t -= dt
        if (p.t <= 0) {
          Object.assign(p, { y: 0, lean: 0, pose: "stand" })
          unitP = null
          const d = team.doctora
          d.pose = mode === "sin" ? "sitSlump" : "calmSit"
          if (mode === "sin") {
            if (chance(0.5)) {
              d.task = "ficha"
              d.pose = "stand"
              d.path = RUTA_FICHA.map((w) => [...w])
              d.next = "mostrador"
            } else {
              d.task = "nota"
              d.t = between(2.5, 4)
            }
          } else d.task = "libre"
          filaCaja.push(p)
          p.cajaAt = filaCaja.length - 1
          walk(
            p,
            [CONS_B, CONS_A, [2.3, 3.15], FILA_CAJA[Math.min(p.cajaAt, FILA_CAJA.length - 1)]],
            "filaCaja",
          )
        }
        break
      case "harto":
        p.t -= dt
        if (p.t <= 0) goLost(p)
        break
      case "volverMsg":
        p.t -= dt
        if (p.t <= 0) {
          if (p.returns) {
            release(p)
            counts.volvieron++
            p.dim = 0
            p.story = "vuelve"
            p.bubble = "cal"
            counts.agendados++
            emit("agenda", p)
            become(p, "agendado", 1.1)
          } else {
            p.declined = true
            counts.noVuelven++
            p.story = "no-vuelve"
            p.bubble = "dots"
            p.dim = 0.6
            become(p, "perdido")
            p.pose = "lost"
          }
        }
        break
      case "perdido":
        if (p.bubble === "dots" && time - p.since > 2.5) p.bubble = null
        break
      default:
        break
    }
  }
  function move(p, dt) {
    if (!p.path.length) {
      p.walking = false
      return
    }
    const [tx, tz] = p.path[0]
    const dx = tx - p.x
    const dz = tz - p.z
    const d = Math.hypot(dx, dz)
    if (d < 0.1) {
      p.path.shift()
      if (!p.path.length) {
        p.x = tx
        p.z = tz
        p.walking = false
        if (p.kind === "cliente") arrive(p)
      }
      return
    }
    const s = Math.min(d, p.speed * dt)
    p.x += (dx / d) * s
    p.z += (dz / d) * s
    p.face = Math.atan2(dx, dz)
    p.walking = true
  }
  /** Nadie atraviesa a nadie: quien camina se aparta un poco de quien tiene cerca. */
  function separate(dt) {
    const list = people.filter((p) => p.active && p.kind === "cliente" && p.state !== "tratamiento")
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      if (!a.walking) continue
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue
        const b = list[j]
        const dx = a.x - b.x
        const dz = a.z - b.z
        const d2 = dx * dx + dz * dz
        if (d2 > 0.2 || d2 < 1e-5) continue
        const d = Math.sqrt(d2)
        const push = ((0.45 - d) / d) * 1.5 * dt
        a.x += dx * push
        a.z += dz * push
      }
    }
  }

  function stepRecovery(dt) {
    recoverIn -= dt
    if (recoverIn > 0) return
    recoverIn = between(0.7, 1.2)
    const p = people.find((q) => q.active && q.state === "perdido" && !q.declined)
    if (!p) return
    p.returns = chance(0.55)
    p.bubble = "sofi"
    p.dim = 0.2
    p.story = "vuelta-msg"
    p.pose = "phone"
    emit("recupera", p)
    become(p, "volverMsg", 1.1)
  }

  function step(dt) {
    time += dt
    spawnIn -= dt
    if (spawnIn <= 0) {
      spawnIn = night ? between(1.7, 3) : between(1.3, 2.5)
      arrival()
    }
    if (mode !== "sin") {
      citaIn -= dt
      if (!night && citaIn <= 0 && scheduled > 0 && fila.length + sala.length < 3) {
        citaIn = between(4, 6)
        scheduled--
        walkIn(true)
      }
      if (clearing > 0) {
        clearing -= dt
        if (clearing <= 0) {
          clearing = counts.sinResponder > 0 ? 0.15 : 0
          if (counts.sinResponder > 0) {
            counts.sinResponder--
            emit("limpia")
          }
        }
      }
    }
    if (recovering) stepRecovery(dt)
    for (const p of people) {
      if (!p.active) continue
      move(p, dt)
      if (p.kind === "cliente") stepClient(p, dt)
      p.yaw = angleTo(p.yaw, p.face, 7, dt)
    }
    separate(dt)
    for (const key of Object.keys(EQUIPO)) {
      const p = team[key]
      if (p.leaving && !p.path.length) {
        p.leaving = false
        p.active = false
      }
      if (p.returning && !p.path.length) {
        const home = EQUIPO[key]
        Object.assign(p, {
          returning: false,
          away: false,
          x: home.x,
          z: home.z,
          face: home.yaw,
          task: "idle",
          t: 0,
          next: "",
          speed: 2,
        })
      }
    }
    if (!team.recep.away) stepRecep(team.recep, dt)
    if (!team.doctora.away) stepDoctora(team.doctora, dt)
    if (!team.caja.away) stepCaja(team.caja, dt)
    if (!team.director.away) stepDirector(team.director, dt)
    // La fila se cuenta con quien ya está en ella, no con quien aún viene caminando por la calle.
    counts.fila = fila.filter((p) => p.state === "fila" || p.state === "atendiendo").length
    counts.sala = sala.length
  }

  reset()

  return {
    people,
    team,
    counts,
    get mode() {
      return mode
    },
    get antes() {
      return antes
    },
    get flavor() {
      return flavor
    },
    get night() {
      return night
    },
    /** Con qué trabaja la clínica antes de los agentes: «hoy», «bot» o «crm». */
    setFlavor(f) {
      flavor = f
    },
    /** Ya cerró: se fue el equipo y solo quedan los que se fueron antes y quienes escriben desde su casa. */
    closeNow() {
      for (const p of people) {
        if (p.kind === "cliente") {
          if (!p.active || p.state === "perdido" || p.next === "perdido") continue
          release(p)
          p.active = false
          p.path = []
        } else {
          Object.assign(p, {
            away: true,
            active: false,
            leaving: false,
            returning: false,
            path: [],
            next: "",
            serving: null,
            payer: null,
            caller: null,
          })
        }
      }
      fila = []
      filaCaja = []
      sala = []
      unitP = null
      night = true
    },
    /** Amanece: el equipo vuelve a su puesto, cada quien por su camino. */
    dawn() {
      night = false
      for (const key of Object.keys(EQUIPO)) {
        const p = team[key]
        const route = [...RUTA_SALIDA[key]].reverse().slice(1)
        route.push([EQUIPO[key].x, EQUIPO[key].z])
        Object.assign(p, {
          active: true,
          away: true,
          leaving: false,
          returning: true,
          x: SALIDA[0],
          z: SALIDA[1],
          yaw: -PI / 2,
          face: -PI / 2,
          pose: "stand",
          speed: 2.6,
          path: route.map((w) => [w[0], w[1]]),
        })
      }
    },
    get recovering() {
      return recovering
    },
    get time() {
      return time
    },
    reset,
    step,
    /** Avanza sin mirar: para llegar a un momento con la clínica ya en marcha. */
    advance(seconds, dt = 0.1) {
      for (let t = 0; t < seconds; t += dt) step(dt)
      events = []
    },
    drain() {
      const out = events
      events = []
      return out
    },
    /** Con odentIA la demanda sigue igual: los que esperaban una respuesta la reciben, uno tras otro. */
    withAgents() {
      if (mode !== "sin") return
      const esperan = ["escribe", "fila", "atendiendo"]
      const enEspera = people.filter(
        (p) =>
          p.active &&
          p.kind === "cliente" &&
          (esperan.includes(p.state) ||
            (p.state === "camino" && (p.next === "escribe" || p.next === "fila"))),
      ).length
      antes = {
        llegaron: counts.llegaron,
        atendidos: counts.atendidos,
        fueron: counts.fueron,
        enEspera,
      }
      mode = "con"
      clearing = 0.1
      for (const p of people) {
        if (!p.active || p.kind !== "cliente") continue
        p.patience = Number.POSITIVE_INFINITY
        if (p.state === "sala" || p.state === "fila")
          p.story = p.state === "sala" ? "sala-con" : "fila-con"
      }
      // La fila se deshace desde atrás, uno tras otro: es lo primero que se ve al llegar Sofi.
      fila.forEach((p, j) => {
        if (j >= 2) p.answerAt = time + 0.7 + (fila.length - j) * 0.42
      })
      const r = team.recep
      if (r.task === "agobio" || r.task === "copia") r.t = 0
    },
    startRecovery() {
      recovering = true
      recoverIn = 0.2
    },
    /** Lo que espera a una persona, en palabras de sim: para la ventana que se abre al tocarla. */
    waited(p) {
      return time - (p.since ?? time)
    },
  }
}
