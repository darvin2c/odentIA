// Las pantallas de muestra de «Todo lo de siempre»: al tocar un módulo se abre su ventana con una
// pantalla pequeña que hace una sola cosa en unos segundos. Se parecen a las de la app (la ventana
// clara del buscador de la parte 8; el arco y las piezas del odontograma son los de
// @odentia/dental, como en la web). deck.js las toma de `window.ModuleScreens` y les pasa su espera,
// para que se detengan al cambiar de parte. El motor es el de ../module-screens-core.
import { type ArchRows, archLayout } from "@odentia/dental/odontogram-arch"
import {
  CROWN_SQUARE,
  groovesFor,
  MISSING_TOOTH_LINES,
  silhouetteFor,
  toothTypeOf,
  zonesFor,
} from "@odentia/dental/tooth-shapes"
import { html, type ModuleScreen, pill, registerScreens, row, scripted, type Step, toast } from "../module-screens-core"

/* ---------- Agenda: Sofi llena el hueco de las 10:00 ---------- */
function agenda(): ModuleScreen {
  const hours = ["09:00", "10:00", "11:00", "12:00"]
  const body = html(
    "ms-agenda",
    `<div class="ms-bar"><span class="ms-seg"><b>Día</b><span>Semana</span></span><span class="ms-btn">Nueva cita</span></div>
    <div class="ms-grid">
      <span></span><b class="ms-col">Dra. Ana Paredes</b><b class="ms-col">Dr. Luis Ríos</b>
      ${hours.map((h, i) => `<span class="ms-h" style="grid-row:${i + 2}">${h}</span><i style="grid-row:${i + 2}"></i>`).join("")}
      <div class="ms-ap" style="grid-column:2; grid-row:2"><b>Mario T. · Control</b><span class="ms-st amber">Llegó 09:02 · espera 4 min</span></div>
      <div class="ms-ap libre" id="msFree" style="grid-column:2; grid-row:3"><span>Libre</span></div>
      <div class="ms-ap" style="grid-column:2; grid-row:4"><b>Rosa M. · Profilaxis</b><span class="ms-st">11:00 · por llegar</span></div>
      <div class="ms-ap" style="grid-column:3; grid-row:2 / span 2"><b>Carla S. · Endodoncia</b><span class="ms-st teal">En atención · con el Dr. Ríos desde 09:35</span></div>
      <div class="ms-ap" style="grid-column:3; grid-row:5"><b>Pedro R. · Control</b><span class="ms-st">12:00 · confirmó</span></div>
    </div>
    <div class="ms-wa" id="msWa"><span class="ms-wa-h">WhatsApp · Jorge P. · 21:30</span><p>Hola, ¿tienen cita mañana a las 10? Quiero hacerme un blanqueamiento.</p></div>
    <div class="ms-toast" id="msToast"><span class="ms-dot sky"></span>Sofi le confirmó la cita a Jorge por WhatsApp</div>`,
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
      free.classList.remove("libre", "pending")
      free.classList.add("new")
      free.innerHTML = `<b>Jorge P. · Evaluación</b><span class="ms-st sky">Agendó Sofi · por WhatsApp, a las 21:31</span>`
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
      <div class="ms-voice" id="msVoice"><span class="ms-dot mint"></span><span>Clío escuchó: <q>la dieciséis, caries oclusal; hacemos resina</q></span></div>
      <div class="ms-panel" id="msPanel">
        <span class="ms-k">Sugerencias de Clío</span>
        <b>Pieza 16 · primer molar superior derecho</b>
        <div class="ms-chips"><span class="on">Caries</span><span>Restauración</span><span>Corona</span><span>Ausente</span></div>
        <span class="ms-f">Cara <b>Oclusal</b></span>
        <span class="ms-f">Diagnóstico <b>CIE-10 · K02.1 Caries de la dentina</b></span>
        <span class="ms-f">Tratamiento <b>Resina oclusal</b></span>
        <span class="ms-btn" id="msOk">Confirmar</span>
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
    sub: "Lucía Torres · atención con la Dra. Ana Paredes",
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

const historia = scripted(
  "Historia clínica",
  "Lucía Torres · qué pasó y cuándo",
  "",
  `<div class="ms-alert ms-in" data-s="al"><b>Alergia: penicilina</b><span>La ve todo el equipo clínico, en cada atención.</span></div>
  <div class="ms-rows">
    ${row("r1", "12 ago", "Evaluación", "Dra. Ana Paredes · odontograma inicial", pill("Firmada"))}
    ${row("r2", "02 sep", "Profilaxis", "Dr. Luis Ríos", pill("Firmada"))}
    ${row("r3", "02 sep", "Radiografía panorámica", "Imagen · piezas 36 y 46", pill("Documento"))}
    ${row("r4", "Hoy 10:42", "Resina oclusal · pieza 16", "Dra. Ana Paredes · dictada con Clío", pill("Firmada", "teal"))}
  </div>
  ${toast("Atención firmada: ya está en la historia de Lucía", "mint")}`,
  [[300, "[data-s=al]"], [350, "[data-s=r1]"], [250, "[data-s=r2]"], [250, "[data-s=r3]"], [900, "[data-s=r4]"], [150, "[data-s=r4]", "hl"], [500, "[data-s=toast]"]],
)

const PERIO: [number, number[]][] = [
  [18, [3, 2, 3]], [17, [3, 3, 4]], [16, [5, 4, 5]], [15, [3, 2, 3]],
  [14, [2, 2, 3]], [13, [3, 2, 2]], [12, [2, 1, 2]], [11, [2, 2, 2]],
]
const periodontograma = scripted(
  "Periodontograma",
  "Lucía Torres · sondaje, cara vestibular",
  "ms-perio",
  `<div class="ms-bar"><span class="ms-k">Una pieza a la vez, con el teclado · se guarda sola</span>${pill("Arcada superior derecha", "teal")}</div>
  <div class="ms-pgrid">${PERIO.map(
    ([tooth, mm], i) => `<div class="ms-pc" data-s="c${i}"><b>${tooth}</b><span class="v">${mm
      .map((v) => `<i class="${v >= 4 ? "deep" : ""}">${v}</i>`)
      .join("")}</span><span class="bl">${mm.some((v) => v >= 4) ? "Sangra" : ""}</span></div>`,
  ).join("")}</div>
  <div class="ms-card ms-in" data-s="prop"><span class="ms-k">Propuesta con lo medido</span><b>Periodontitis · estadio II, grado B</b><small>Bolsas de 4 y 5 mm en la 16 y la 17, con sangrado.</small><span class="ms-btn" data-s="ok">Confirmar diagnóstico</span></div>
  ${toast("Diagnóstico confirmado por la Dra. Ana Paredes", "mint")}`,
  [
    ...PERIO.map((_, i): Step => [i === 0 ? 400 : 260, `[data-s=c${i}]`]),
    [500, "[data-s=prop]"],
    [1000, "[data-s=ok]", "press"],
    [300, "[data-s=toast]"],
  ],
)

const tomografia = scripted(
  "Visor de tomografías",
  "Lucía Torres · panorámica y cortes",
  "ms-ct",
  `<div class="ms-ctv">
    <div class="ms-pano"><img src="/img/imaging/pano-hueso.jpg" alt="" /><span class="ms-cut" data-s="cut"><em>Pieza 36</em></span></div>
    <div class="ms-cross">${[-2, -1, 0, 1, 2]
      .map((mm, i) => `<figure class="ms-in" data-s="x${i}"><img src="/img/imaging/cross.jpg" alt="" style="object-position:${40 + i * 5}% 50%" /><figcaption>${mm > 0 ? "+" : ""}${mm} mm</figcaption>${i === 2 ? '<span class="ms-measure" data-s="m"><i></i><b>11,4 mm</b></span>' : ""}</figure>`)
      .join("")}</div>
  </div>
  <div class="ms-bar"><span class="ms-k">Se abre en el navegador, sin instalar nada · medidas orientativas</span><span class="ms-btn ghost" data-s="save">Guardar vista en la atención</span></div>`,
  [[500, "[data-s=cut]"], [900, "[data-s=x0]"], [180, "[data-s=x1]"], [180, "[data-s=x2]"], [180, "[data-s=x3]"], [180, "[data-s=x4]"], [600, "[data-s=m]"], [900, "[data-s=save]", "press"]],
)

const recetas = scripted(
  "Recetas y órdenes",
  "Lucía Torres · receta de la atención de hoy",
  "ms-rx",
  `<div class="ms-card"><span class="ms-k">Medicamento</span><b class="ms-field" data-s="med">&nbsp;</b><small data-s="dose">&nbsp;</small><span class="ms-in" data-s="why">${pill("Cambiado por la alergia a la penicilina", "amber")}</span></div>
  <div class="ms-alert ms-in" data-s="al"><b>Lucía es alérgica a la penicilina.</b><span>La amoxicilina es una penicilina.</span><span class="ms-acts"><span class="ms-btn" data-s="chg">Cambiar medicamento</span><span class="ms-btn ghost">Recetar igual, con motivo</span></span></div>
  <div class="ms-bar"><span></span><span class="ms-btn ms-in" data-s="emit">Emitir receta</span></div>
  ${toast("Receta emitida con tu firma y enviada a Lucía")}`,
  [
    [400, "[data-s=med]", "", "Amox"],
    [160, "[data-s=med]", "", "Amoxicilina 5"],
    [160, "[data-s=med]", "", "Amoxicilina 500 mg"],
    [500, "[data-s=al]"],
    [1300, "[data-s=chg]", "press"],
    [300, "[data-s=al]", "-on"],
    [200, "[data-s=med]", "ok", "Clindamicina 300 mg"],
    [10, "[data-s=dose]", "", "La pauta que indica la Dra. Ana Paredes"],
    [200, "[data-s=why]"],
    [400, "[data-s=emit]"],
    [700, "[data-s=emit]", "press"],
    [300, "[data-s=toast]"],
  ],
)

const SIGN = "M20 70 C 40 20, 60 20, 62 60 S 80 95, 100 55 S 130 15, 140 60 C 146 80, 160 80, 172 50 C 180 30, 196 30, 200 62 S 230 80, 260 40 L 300 58"
const consentimientos = scripted(
  "Consentimientos",
  "Lucía Torres · endodoncia, pieza 36",
  "ms-cons",
  `<div class="ms-doc">
    <b>Consentimiento informado · Endodoncia</b>
    <span class="ln"></span><span class="ln"></span><span class="ln s"></span>
    <span class="ms-check" data-s="k1"><i></i>Me explicaron el procedimiento y sus riesgos.</span>
    <span class="ms-check" data-s="k2"><i></i>Sé que puedo hacer preguntas antes de firmar.</span>
    <div class="ms-sigbox"><svg class="ms-sig" data-s="sig" viewBox="0 0 320 110" aria-hidden="true"><path d="${SIGN}"/></svg><small>Firma de Lucía Torres</small></div>
  </div>
  <div class="ms-bar"><span class="ms-k ms-in" data-s="who">Firmó en la unidad dental · 10:12 · confirmó la Dra. Ana Paredes</span><span class="ms-in" data-s="ok">${pill("Firmado", "green")}</span></div>`,
  [[500, "[data-s=k1]"], [450, "[data-s=k2]"], [400, "[data-s=sig]"], [1700, "[data-s=who]"], [200, "[data-s=ok]"]],
)

const presupuestos = scripted(
  "Plan y presupuestos",
  "Lucía Torres · pieza 36, tres opciones",
  "ms-budget",
  `<div class="ms-opts">
    <div class="ms-opt ms-in" data-s="a"><span class="ms-k">Opción A</span><b>Resina compuesta</b><span class="p">USD 60</span></div>
    <div class="ms-opt ms-in" data-s="b"><span class="ms-k">Opción B · recomendada</span><b>Incrustación de cerámica</b><span class="p">USD 280</span><span class="ms-in" data-s="acc">${pill("Aceptada desde su enlace", "green")}</span></div>
    <div class="ms-opt ms-in" data-s="c"><span class="ms-k">Opción C</span><b>Corona de zirconio</b><span class="p">USD 450</span></div>
  </div>
  <div class="ms-bar"><span class="ms-k">Sale por WhatsApp, con su enlace para aceptar</span><span class="ms-btn" data-s="send">Enviar a Lucía</span></div>
  <div class="ms-wa" data-s="wa"><span class="ms-wa-h">WhatsApp · Lucía T. · 18:05</span><p>Listo, acepté la opción B. ¿Me agendan?</p></div>`,
  [[300, "[data-s=a]"], [180, "[data-s=b]"], [180, "[data-s=c]"], [800, "[data-s=send]", "press"], [900, "[data-s=wa]"], [900, "[data-s=b]", "won"], [10, ".ms-opts", "decided"], [200, "[data-s=acc]"]],
)

const caja = scripted(
  "Caja y cobros",
  "Lucía Torres · su cuenta",
  "ms-cash",
  `<div class="ms-rows">
    ${row("r1", "02 sep", "Incrustación de cerámica · pieza 36", "Plan aceptado", `<span class="amt">USD 280</span>`, "on")}
    ${row("r2", "02 sep", "Pago · efectivo", "Recibo 0142", `<span class="amt">− USD 100</span>`, "on")}
    ${row("r3", "Hoy 10:50", "Pago · tarjeta", "Recibo 0187", `<span class="amt">− USD 180</span>`)}
  </div>
  <div class="ms-due"><span>Le falta pagar</span><b data-s="due">USD 180</b><span class="ms-in" data-s="ok">${pill("Al día", "green")}</span></div>
  ${toast("Comprobante enviado a Lucía por correo; también queda en su enlace")}`,
  [[700, "[data-s=r3]"], [150, "[data-s=r3]", "hl"], [500, "[data-s=due]", "zero", "USD 0"], [250, "[data-s=ok]"], [500, "[data-s=toast]"]],
)

const finanzas = scripted(
  "Finanzas y gastos",
  "Sede Centro · septiembre",
  "ms-fin",
  `<div class="ms-tiles">
    <div class="ms-tile"><span>Entró</span><b>USD 11.200</b></div>
    <div class="ms-tile"><span>Salió</span><b data-s="out">USD 4.150</b></div>
    <div class="ms-tile main"><span>Te queda</span><b data-s="left">USD 7.050</b></div>
  </div>
  <div class="ms-rows">
    ${row("g1", "03 sep", "Alquiler del local", "Gasto fijo", `<span class="amt">USD 1.600</span>`, "on")}
    ${row("g2", "15 sep", "Sueldos del equipo", "Gasto fijo", `<span class="amt">USD 2.550</span>`, "on")}
    ${row("g3", "Hoy", "Laboratorio dental · incrustación de Lucía", "Gasto del tratamiento", `<span class="amt">USD 240</span>`)}
  </div>`,
  [[700, "[data-s=g3]"], [150, "[data-s=g3]", "hl"], [450, "[data-s=out]", "bump", "USD 4.390"], [250, "[data-s=left]", "bump", "USD 6.810"]],
)

const comisiones = scripted(
  "Comisiones",
  "Dra. Ana Paredes · octubre · 30 %",
  "ms-comm",
  `<div class="ms-rows">
    ${row("c1", "08 oct", "Endodoncia · Carla S.", "USD 220 cobrados", `<span class="amt">USD 66</span>`, "on")}
    ${row("c2", "14 oct", "Profilaxis · Mario T.", "USD 35 cobrados", `<span class="amt">USD 10,50</span>`, "on")}
    ${row("c3", "Hoy", "Resina oclusal · Lucía T.", "USD 60 cobrados", `<span class="amt">USD 18</span>`)}
  </div>
  <div class="ms-due"><span>Le toca este mes</span><b data-s="tot">USD 1.242</b><span class="ms-k">Se calcula con lo cobrado, no con lo agendado.</span></div>`,
  [[700, "[data-s=c3]"], [150, "[data-s=c3]", "hl"], [450, "[data-s=tot]", "bump", "USD 1.260"]],
)

const inventario = scripted(
  "Inventario y compras",
  "Sede Norte · materiales",
  "ms-inv",
  `<div class="ms-rows">
    ${row("i1", "", "Resina A2", "Mínimo 5 · último pedido hace 40 días", `<span class="amt" data-s="q">Quedan 6</span>`, "on")}
    ${row("i2", "", "Anestesia lidocaína 2 %", "Mínimo 20", `<span class="amt">Quedan 48</span>`, "on")}
    ${row("i3", "", "Guantes de nitrilo M", "Mínimo 10 cajas", `<span class="amt">Quedan 14</span>`, "on")}
  </div>
  <div class="ms-bar"><span class="ms-in" data-s="low">${pill("Resina A2 está bajo el mínimo", "amber")}</span><span class="ms-btn ms-in" data-s="buy">Crear orden de compra</span></div>
  ${toast("Orden de compra lista: 10 resinas A2")}`,
  [[700, "[data-s=q]", "bump", "Quedan 4"], [100, "[data-s=i1]", "low"], [300, "[data-s=low]"], [300, "[data-s=buy]"], [800, "[data-s=buy]", "press"], [300, "[data-s=toast]"]],
)

const portal = scripted(
  "Portal del paciente",
  "Lo que ve Lucía en su celular",
  "ms-portal",
  `<div class="ms-phone">
    <span class="ms-k">Clínica Sonrisa</span>
    <b class="hi">Hola, Lucía</b>
    <div class="ms-pcard"><span class="ms-k">Tu próxima cita</span><b>Viernes 23 · 10:00</b><small>Dra. Ana Paredes · Sede Norte</small><span class="lnk">Cambiar</span></div>
    <div class="ms-pcard" data-s="dec"><span class="ms-k">Por decidir</span><b data-s="dect">Tu presupuesto · 3 opciones</b><span class="ms-btn" data-s="go">Ver y aceptar</span></div>
    <div class="ms-pcard"><span class="ms-k">Tus papeles</span><small>Receta · Consentimiento · Comprobante</small></div>
  </div>
  <div class="ms-side">
    <b>Entra con su huella o su cara.</b>
    <span>Sin contraseñas ni aplicaciones que instalar.</span>
    <span class="ms-in" data-s="seen">${pill("La clínica ya lo ve en el plan de Lucía", "teal")}</span>
  </div>`,
  [[900, "[data-s=go]", "press"], [300, "[data-s=dect]", "", "Aceptaste la opción B · USD 280"], [10, "[data-s=dec]", "done"], [10, "[data-s=go]", "-press", "Elegir horario"], [500, "[data-s=seen]"]],
)

const oportunidades = scripted(
  "Oportunidades y tareas",
  "Ventas de la clínica · cada tarjeta dice por qué está ahí",
  "ms-pipe",
  `<div class="ms-cols">
    <div class="ms-colp"><span class="ms-k">Interesado</span><div class="ms-opp"><b>Jorge P.</b><small>Blanqueamiento · escribió ayer</small></div></div>
    <div class="ms-colp"><span class="ms-k">Evaluación agendada</span><div class="ms-opp"><b>Ana V.</b><small>Ortodoncia · cita el lunes</small></div></div>
    <div class="ms-colp"><span class="ms-k">Presupuesto enviado</span>
      <div class="ms-opp" data-s="rosa"><b>Rosa M.</b><small>Ortodoncia · USD 1.800</small><span class="ms-in" data-s="argos">${pill("Argos: 14 días sin respuesta", "amber")}</span><span class="ms-in" data-s="sofi">${pill("Sofi se lo recordó por WhatsApp", "teal")}</span></div>
      <div class="ms-opp"><b>Mario T.</b><small>Implante · enviado hoy</small></div></div>
    <div class="ms-colp"><span class="ms-k">Decidió</span><div class="ms-opp ms-in" data-s="won"><b>Rosa M.</b><small>Ortodoncia · USD 1.800</small>${pill("Ganada · aceptó por WhatsApp", "green")}</div></div>
  </div>`,
  [[700, "[data-s=argos]"], [900, "[data-s=sofi]"], [1000, "[data-s=rosa]", "gone"], [250, "[data-s=won]"]],
)

const SPARK = "0,60 40,52 80,56 120,40 160,44 200,30 240,34 280,18 320,22 360,8"
const reportes = scripted(
  "Reportes",
  "Toda la clínica · septiembre frente a agosto",
  "ms-rep",
  `<div class="ms-tiles">
    <div class="ms-tile"><span>Cobrado</span><b>USD 18.420</b><small>8 % más que en agosto</small><svg class="ms-spark" data-s="sp" viewBox="0 0 360 70" aria-hidden="true"><polyline points="${SPARK}"/></svg></div>
    <div class="ms-tile"><span>Citas atendidas</span><b>412</b><small>5 % más que en agosto</small></div>
    <div class="ms-tile"><span>Pacientes nuevos</span><b>37</b><small>3 menos que en agosto</small></div>
  </div>
  <div class="ms-ask"><span class="ms-k">Pregúntale a Argos ›</span><b data-s="q">&nbsp;</b></div>
  <div class="ms-card ms-in" data-s="ans"><span class="ms-k">Argos</span><b>14 pacientes no volvieron a su control este mes.</b><small>Con «Avisar un control», Sofi les escribe. · Ver la lista</small></div>`,
  [
    [300, "[data-s=sp]"],
    [900, "[data-s=q]", "", "¿Quién no volvió"],
    [250, "[data-s=q]", "", "¿Quién no volvió a su control"],
    [250, "[data-s=q]", "", "¿Quién no volvió a su control este mes?"],
    [800, "[data-s=ans]"],
  ],
)

const equipo = scripted(
  "Sedes, equipo y permisos",
  "Clínica Sonrisa · 2 sedes",
  "ms-team",
  `<div class="ms-teamg">
    <div class="ms-rows">
      ${row("t1", "", "Dra. Ana Paredes", "Odontóloga · Sede Norte", "", "on")}
      ${row("t2", "", "Dr. Luis Ríos", "Odontólogo · Norte y Centro", "", "on")}
      ${row("t3", "", "Carla Soto", "Recepción · Sede Norte", "", "on")}
      ${row("t4", "", "Pedro Ruiz", "Recepción · Sede Centro", pill("Invitación enviada", "teal"))}
    </div>
    <div class="ms-card"><span class="ms-k">Lo que ve Recepción</span>
      <span class="ms-perm">Agenda <i>✓</i></span><span class="ms-perm">Conversaciones <i>✓</i></span><span class="ms-perm">Pacientes <i>✓</i></span>
      <span class="ms-perm no" data-s="clin">Historia clínica <i>✕</i></span>
    </div>
  </div>
  <div class="ms-bar"><span class="ms-in" data-s="free">${pill("USD 0 por usuario y por sede", "green")}</span><span class="ms-btn" data-s="inv">Invitar a alguien</span></div>`,
  [[600, "[data-s=inv]", "press"], [300, "[data-s=t4]"], [150, "[data-s=t4]", "hl"], [700, "[data-s=clin]", "flag"], [500, "[data-s=free]"]],
)

registerScreens({
  agenda,
  odontograma,
  periodontograma,
  historia,
  tomografia,
  recetas,
  consentimientos,
  presupuestos,
  caja,
  finanzas,
  comisiones,
  inventario,
  portal,
  oportunidades,
  reportes,
  equipo,
})
