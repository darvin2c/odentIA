// Las pantallas de muestra de «Todo lo de siempre»: al tocar un módulo se abre su ventana con una
// pantalla pequeña que hace una sola cosa en unos segundos. Se parecen a las de la app (la ventana
// clara del buscador de la parte 8; el arco y las piezas del odontograma son los de
// @odentia/dental, como en la web). deck.js las toma de `window.ModuleScreens` y les pasa su espera,
// para que se detengan al cambiar de parte.
import { type ArchRows, archLayout } from "@odentia/dental/odontogram-arch"
import {
  CROWN_SQUARE,
  groovesFor,
  MISSING_TOOTH_LINES,
  silhouetteFor,
  toothTypeOf,
  zonesFor,
} from "@odentia/dental/tooth-shapes"

type Wait = (ms: number) => Promise<void>
export interface ModuleScreen {
  title: string
  sub: string
  body: HTMLElement
  play: (wait: Wait) => Promise<void>
}

const html = (cls: string, inner: string) => {
  const node = document.createElement("div")
  node.className = cls
  node.innerHTML = inner
  return node
}

/* ---------- Agenda: Sofi llena el hueco de las 10:00 ---------- */
function agenda(): ModuleScreen {
  const hours = ["09:00", "10:00", "11:00", "12:00"]
  const body = html(
    "ms-agenda",
    `<div class="ms-bar"><span class="ms-seg"><b>Día</b><span>Semana</span></span><span class="ms-btn">Nueva cita</span></div>
    <div class="ms-grid">
      <span></span><b class="ms-col">Dra. Ana Torres</b><b class="ms-col">Dr. Luis Ríos</b>
      ${hours.map((h, i) => `<span class="ms-h" style="grid-row:${i + 2}">${h}</span><i style="grid-row:${i + 2}"></i>`).join("")}
      <div class="ms-ap" style="grid-column:2; grid-row:2"><b>Mario T. · Control</b><span class="ms-st amber">Llegó 09:02 · espera 4 min</span></div>
      <div class="ms-ap free" id="msFree" style="grid-column:2; grid-row:3"><span>Libre</span></div>
      <div class="ms-ap" style="grid-column:2; grid-row:4"><b>Rosa M. · Profilaxis</b><span class="ms-st">11:00 · por llegar</span></div>
      <div class="ms-ap" style="grid-column:3; grid-row:2 / span 2"><b>Carla S. · Endodoncia</b><span class="ms-st teal">En atención · con el Dr. Ríos desde 09:35</span></div>
      <div class="ms-ap" style="grid-column:3; grid-row:5"><b>Pedro R. · Control</b><span class="ms-st">12:00 · confirmó</span></div>
    </div>
    <div class="ms-wa" id="msWa"><span class="ms-wa-h">WhatsApp · Lucía M. · 22:47</span><p>Hola, ¿tienen cita mañana a las 10? Me duele una muela.</p></div>
    <div class="ms-toast" id="msToast"><span class="ms-dot sky"></span>Sofi le confirmó la cita a Lucía por WhatsApp</div>`,
  )
  const free = body.querySelector<HTMLElement>("#msFree")!
  const wa = body.querySelector<HTMLElement>("#msWa")!
  const toast = body.querySelector<HTMLElement>("#msToast")!
  return {
    title: "Agenda",
    sub: "Sede Norte · viernes 23",
    body,
    play: async (wait) => {
      await wait(500)
      wa.classList.add("on")
      await wait(1200)
      free.classList.add("pending")
      free.innerHTML = `<span class="ms-typing"><i></i><i></i><i></i></span><span>Sofi está agendando…</span>`
      await wait(1100)
      free.classList.remove("free", "pending")
      free.classList.add("new")
      free.innerHTML = `<b>Lucía M. · Evaluación</b><span class="ms-st sky">Agendó Sofi · por WhatsApp, a las 22:48</span>`
      await wait(500)
      toast.classList.add("on")
    },
  }
}

/* ---------- Odontograma: Clío escucha la caries de la 16 y pasa al plan ---------- */
const ADULT: ArchRows = {
  upper: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  lower: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
}
/** Rojo y azul de la norma, los mismos de la app. */
const RED = "#dc2626"
const BLUE = "#2563eb"
type Finding = "caries" | "ausente" | "corona" | "restauracion"
const START: Partial<Record<number, Finding>> = { 36: "restauracion", 48: "ausente", 26: "corona" }

function crown(tooth: number, finding: Finding | undefined): string {
  const type = toothTypeOf(tooth)
  const silhouette = silhouetteFor(type)
  const zones = zonesFor(tooth, true)
  const central = zones.find((zone) => zone.surface === "occlusal" || zone.surface === "incisal")
  const paint = finding === "caries" ? RED : BLUE
  const clip = `ms-clip-${tooth}`
  const fill = (zone: (typeof zones)[number]) =>
    zone === central && (finding === "caries" || finding === "restauracion")
      ? `fill="${paint}" fill-opacity="1"`
      : `fill="#fff" fill-opacity=".55"`
  const extra =
    finding === "ausente"
      ? `<g stroke="${BLUE}" fill="none" stroke-width="1" stroke-linecap="round">${MISSING_TOOTH_LINES.map((l) => `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}"/>`).join("")}</g>`
      : finding === "corona"
        ? `<rect x="${CROWN_SQUARE.x}" y="${CROWN_SQUARE.y}" width="${CROWN_SQUARE.width}" height="${CROWN_SQUARE.height}" fill="none" stroke="${BLUE}" stroke-width="1"/>`
        : ""
  return `<svg viewBox="3 0 18 15" class="ms-crown" stroke-width=".6" aria-hidden="true">
    <defs><clipPath id="${clip}"><path d="${silhouette.crown}"/></clipPath></defs>
    <path d="${silhouette.crown}" fill="#fff" stroke="#6b7280" stroke-linejoin="round"/>
    <g clip-path="url(#${clip})">${zones.map((zone) => `<polygon points="${zone.points}" ${fill(zone)} stroke="none"/>`).join("")}</g>
    ${extra}
    ${groovesFor(type).map((d) => `<path d="${d}" fill="none" stroke="#9ca3af" stroke-width=".45" opacity=".7"/>`).join("")}
  </svg>`
}

function odontograma(): ModuleScreen {
  const W = 470
  const layout = archLayout(W, ADULT)
  const H = layout.height
  const pct = (v: number, t: number) => `${((v / t) * 100).toFixed(3)}%`
  const arch = `<div class="ms-arch" style="aspect-ratio:${W} / ${H}">
    <svg class="ms-under" viewBox="0 0 ${W} ${H}" aria-hidden="true">${layout.gums
      .map((g) => `<path d="${g.d}" fill="none" stroke="#d9eff5" stroke-opacity=".7" stroke-width="${g.width.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`)
      .join("")}</svg>
    ${layout.teeth
      .map(
        (t) => `<div class="ms-slot" data-tooth="${t.tooth}" style="left:${pct(t.x, W)}; top:${pct(t.y, H)}; width:${pct(t.w, W)}; transform:translate(-50%,-50%) rotate(${t.rotation.toFixed(2)}deg)">${crown(t.tooth, START[t.tooth])}</div>
        <span class="ms-num" data-num="${t.tooth}" style="left:${pct(t.labelX, W)}; top:${pct(t.labelY, H)}">${t.tooth}</span>`,
      )
      .join("")}
  </div>`
  const body = html(
    "ms-odo",
    `<div class="ms-odo-l">${arch}<div class="ms-legend"><span><i style="background:${RED}"></i>Patología</span><span><i style="background:${BLUE}"></i>Buen estado</span></div></div>
    <div class="ms-odo-r">
      <div class="ms-voice" id="msVoice"><span class="ms-dot mint"></span><span>Clío escuchó: <q>la dieciséis tiene caries oclusal</q></span></div>
      <div class="ms-panel" id="msPanel">
        <span class="ms-k">Sugerencia de Clío</span>
        <b>Pieza 16 · primer molar superior derecho</b>
        <div class="ms-chips"><span class="on">Caries</span><span>Restauración</span><span>Corona</span><span>Ausente</span></div>
        <span class="ms-f">Cara <b>Oclusal</b></span>
        <span class="ms-f">Diagnóstico <b>CIE-10 · K02.1 Caries de la dentina</b></span>
        <span class="ms-btn" id="msOk">Confirmar y agregar al plan</span>
      </div>
      <div class="ms-plan" id="msPlan"><span class="ms-k">Plan de Lucía</span><div><b>Resina oclusal · pieza 16</b><span>Por hacer · agregado hoy</span></div></div>
    </div>`,
  )
  const voice = body.querySelector<HTMLElement>("#msVoice")!
  const panel = body.querySelector<HTMLElement>("#msPanel")!
  const ok = body.querySelector<HTMLElement>("#msOk")!
  const plan = body.querySelector<HTMLElement>("#msPlan")!
  const slot = body.querySelector<HTMLElement>('[data-tooth="16"]')!
  const num = body.querySelector<HTMLElement>('[data-num="16"]')!
  return {
    title: "Odontograma",
    sub: "Lucía Mendoza · atención con la Dra. Ana Torres",
    body,
    play: async (wait) => {
      await wait(600)
      voice.classList.add("on")
      await wait(900)
      slot.classList.add("pick")
      num.classList.add("pick")
      panel.classList.add("on")
      await wait(1300)
      ok.classList.add("press")
      await wait(250)
      slot.innerHTML = crown(16, "caries")
      slot.classList.add("hit")
      await wait(450)
      plan.classList.add("on")
    },
  }
}

;(window as unknown as { ModuleScreens: Record<string, () => ModuleScreen> }).ModuleScreens = {
  agenda,
  odontograma,
}
