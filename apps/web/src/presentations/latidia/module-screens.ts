// Las pantallas de muestra de «Todo lo de siempre» en latidIA: al tocar un módulo se abre su
// ventana con una pantalla pequeña que hace una sola cosa en unos segundos, con las personas de la
// presentación (Rosa, Luis, Julia y la Dra. Vela). El motor es el de ../module-screens-core.
import { pill, registerScreens, row, scripted, toast } from "../module-screens-core"

const agenda = scripted(
  "Agenda por sala",
  "Consultorio San Martín · jueves 23",
  "ms-agenda",
  `<div class="ms-bar"><span class="ms-seg"><b>Día</b><span>Semana</span></span><span class="ms-btn">Nueva cita</span></div>
  <div class="ms-grid">
    <span></span><b class="ms-col">Sala 1 · Dra. Elena Vela</b><b class="ms-col">Sala 2 · Dr. Andrés Ríos</b>
    ${["08:00", "09:00", "10:00", "11:00"].map((h, i) => `<span class="ms-h" style="grid-row:${i + 2}">${h}</span><i style="grid-row:${i + 2}"></i>`).join("")}
    <div class="ms-ap" style="grid-column:2; grid-row:2"><b>Julia R. · Control prenatal</b><span class="ms-st amber">Llegó 07:56 · espera 4 min</span></div>
    <div class="ms-ap libre" id="msFree" style="grid-column:2; grid-row:3"><span>Libre</span></div>
    <div class="ms-ap" style="grid-column:2; grid-row:4"><b>Luis G. · Control de presión</b><span class="ms-st">10:00 · confirmó</span></div>
    <div class="ms-ap" style="grid-column:3; grid-row:2 / span 2"><b>Carmen A. · Consulta</b><span class="ms-st teal">En atención · con el Dr. Ríos desde 08:10</span></div>
    <div class="ms-ap" style="grid-column:3; grid-row:5"><b>Pedro N. · Control</b><span class="ms-st">11:00 · por llegar</span></div>
  </div>
  <div class="ms-wa" id="msWa"><span class="ms-wa-h">WhatsApp · Rosa P. · 23:41</span><p>Tengo fiebre y me duele la garganta. ¿Atienden mañana?</p></div>
  <div class="ms-toast" data-s="toast"><span class="ms-dot sky"></span>Sofi le confirmó la cita a Rosa con el precio de la consulta</div>`,
  [
    [500, "#msWa"],
    [1200, "#msFree", "pending", `<span class="ms-typing"><i></i><i></i><i></i></span><span>Sofi está agendando…</span>`],
    [1100, "#msFree", "-libre"],
    [0, "#msFree", "-pending"],
    [0, "#msFree", "new", `<b>Rosa P. · Consulta</b><span class="ms-st sky">Agendó Sofi · por WhatsApp, a las 23:42</span>`],
    [500, "[data-s=toast]"],
  ],
)

const historia = scripted(
  "Historia clínica",
  "Rosa Paredes · qué pasó y cuándo",
  "",
  `<div class="ms-alert ms-in" data-s="al"><b>Alergia: penicilina</b><span>La ve todo el equipo clínico, en cada atención.</span></div>
  <div class="ms-rows">
    ${row("r1", "12 mar", "Consulta · cefalea", "Dra. Elena Vela", pill("Firmada"))}
    ${row("r2", "04 jun", "Control · presión normal", "Dr. Andrés Ríos", pill("Firmada"))}
    ${row("r3", "04 jun", "Hemograma completo", "Resultado · laboratorio", pill("Documento"))}
    ${row("r4", "Hoy 09:18", "Amigdalitis aguda · descanso de 3 días", "Dra. Elena Vela · dictada con Clío", pill("Firmada", "teal"))}
  </div>
  ${toast("Consulta firmada: ya está en la historia de Rosa", "mint")}`,
  [[300, "[data-s=al]"], [350, "[data-s=r1]"], [250, "[data-s=r2]"], [250, "[data-s=r3]"], [900, "[data-s=r4]"], [150, "[data-s=r4]", "hl"], [500, "[data-s=toast]"]],
)

const VITALS: [string, number, number][] = [["ene", 152, 96], ["abr", 146, 92], ["jul", 138, 88], ["oct", 132, 84]]
const signos = scripted(
  "Signos vitales",
  "Luis Gómez Salas · 62 años · hipertensión",
  "ms-vit",
  `<div class="ms-bar"><span class="ms-seg"><b>Presión arterial</b><span>Peso</span><span>Glucosa</span></span><span class="ms-k">Cada control deja los suyos</span></div>
  <div class="ms-bars">${VITALS.map(
    ([m, s, d], i) => `<div class="ms-vb" data-s="v${i}"><span class="bp">${s}/${d}</span><i style="--h:${((s - 100) / 60) * 100}%"></i><small>${m}</small></div>`,
  ).join("")}</div>
  <div class="ms-card ms-in" data-s="note"><span class="ms-k">En un año</span><b>Bajó de 152/96 a 132/84.</b><small>Lo ves junto a la última medición, sin buscar en papeles.</small></div>`,
  [[400, "[data-s=v0]"], [350, "[data-s=v1]"], [350, "[data-s=v2]"], [350, "[data-s=v3]"], [600, "[data-s=note]"]],
)

const examen = scripted(
  "Examen por sistemas",
  "Rosa Paredes · consulta de hoy",
  "",
  `<div class="ms-voice" data-s="voice"><span class="ms-dot mint"></span><span>Clío escuchó: <q>amígdalas aumentadas, con placas blanquecinas; lo demás, normal</q></span></div>
  <div class="ms-rows">
    ${row("s1", "", "Cabeza y cuello", "", pill("Normal"))}
    ${row("s2", "", "Boca y garganta", "Amígdalas aumentadas, con placas blanquecinas", pill("Hallazgo", "red"))}
    ${row("s3", "", "Tórax y pulmones", "", pill("Normal"))}
    ${row("s4", "", "Cardiovascular", "", pill("Normal"))}
    ${row("s5", "", "Abdomen", "", pill("Normal"))}
  </div>
  <div class="ms-bar"><span class="ms-k">Sugerencias de Clío: las confirma la Dra. Vela</span><span class="ms-btn" data-s="ok">Confirmar</span></div>`,
  [[500, "[data-s=voice]"], [600, "[data-s=s1]"], [150, "[data-s=s2]"], [0, "[data-s=s2]", "hl"], [150, "[data-s=s3]"], [150, "[data-s=s4]"], [150, "[data-s=s5]"], [900, "[data-s=ok]", "press"]],
)

const antecedentes = scripted(
  "Antecedentes",
  "Luis Gómez Salas",
  "",
  `<div class="ms-rows">
    ${row("a1", "", "Hipertensión arterial", "Desde 2019 · en control cada 3 meses", pill("Enfermedad"), "on")}
    ${row("a2", "", "Losartán 50 mg", "Una vez al día", pill("Lo que toma"), "on")}
    ${row("a3", "", "Alergia: ibuprofeno", "Fuerte · le hinchó los labios · lo dijo Luis", pill("Alergia", "red"))}
  </div>
  <div class="ms-card ms-in" data-s="ask"><span class="ms-k">¿Qué tan fuerte fue la reacción?</span><span class="ms-acts"><span class="ms-btn ghost">Leve</span><span class="ms-btn ghost">Moderada</span><span class="ms-btn" data-s="strong">Fuerte</span></span></div>
  ${toast("La receta le avisará si eliges un medicamento con ibuprofeno", "mint")}`,
  [[500, "[data-s=ask]"], [900, "[data-s=strong]", "press"], [300, "[data-s=ask]", "-on"], [100, "[data-s=a3]"], [150, "[data-s=a3]", "hl"], [500, "[data-s=toast]"]],
)

const receta = scripted(
  "Receta",
  "Rosa Paredes · receta de la consulta de hoy",
  "ms-rx",
  `<div class="ms-card"><span class="ms-k">Medicamento</span><b class="ms-field" data-s="med">&nbsp;</b><small data-s="dose">&nbsp;</small><span class="ms-in" data-s="why">${pill("Cambiado por la alergia a la penicilina", "amber")}</span></div>
  <div class="ms-alert ms-in" data-s="al"><b>Rosa es alérgica a la penicilina.</b><span>La amoxicilina es una penicilina.</span><span class="ms-acts"><span class="ms-btn" data-s="chg">Cambiar medicamento</span><span class="ms-btn ghost">Recetar igual, con motivo</span></span></div>
  <div class="ms-bar"><span></span><span class="ms-btn ms-in" data-s="emit">Emitir receta</span></div>
  ${toast("Receta emitida con tu firma y enviada a Rosa")}`,
  [
    [400, "[data-s=med]", "", "Amox"],
    [160, "[data-s=med]", "", "Amoxicilina 5"],
    [160, "[data-s=med]", "", "Amoxicilina 500 mg"],
    [500, "[data-s=al]"],
    [1300, "[data-s=chg]", "press"],
    [300, "[data-s=al]", "-on"],
    [200, "[data-s=med]", "ok", "Azitromicina 500 mg"],
    [10, "[data-s=dose]", "", "La pauta que indica la Dra. Vela"],
    [200, "[data-s=why]"],
    [400, "[data-s=emit]"],
    [700, "[data-s=emit]", "press"],
    [300, "[data-s=toast]"],
  ],
)

const descanso = scripted(
  "Descanso médico",
  "Rosa Paredes · 46 años",
  "",
  `<div class="ms-doc">
    <b>Descanso médico N.º 1</b>
    <span class="ms-big">3 días de descanso</span>
    <small class="ms-k">Del 22/10/2026 al 24/10/2026</small>
    <span class="ms-check on"><i></i>Sin diagnóstico: Rosa no autorizó que figure.</span>
    <span class="ms-k ms-in" data-s="sig">Emitido por Elena Vela · CMP 045678</span>
  </div>
  <div class="ms-bar"><span class="ms-in" data-s="ok">${pill("Le llegó a Rosa por WhatsApp", "green")}</span><span class="ms-btn" data-s="send">Enviar a la persona</span></div>`,
  [[600, "[data-s=sig]"], [900, "[data-s=send]", "press"], [400, "[data-s=ok]"]],
)

const ordenes = scripted(
  "Órdenes y derivaciones",
  "Luis Gómez Salas · control de hoy",
  "",
  `<div class="ms-rows">
    ${row("o1", "", "Perfil lipídico", "Laboratorio · en ayunas", pill("Orden"))}
    ${row("o2", "", "Creatinina y electrolitos", "Laboratorio", pill("Orden"))}
    ${row("o3", "", "Interconsulta · Cardiología", "Motivo: control de hipertensión", pill("Derivación", "teal"))}
  </div>
  <div class="ms-bar"><span class="ms-k">Salen con tu firma; Luis las recibe por su canal</span><span class="ms-btn ms-in" data-s="send">Enviar a Luis</span></div>
  ${toast("Órdenes enviadas a Luis por WhatsApp")}`,
  [[400, "[data-s=o1]"], [300, "[data-s=o2]"], [300, "[data-s=o3]"], [300, "[data-s=send]"], [800, "[data-s=send]", "press"], [300, "[data-s=toast]"]],
)

const SIGN = "M20 70 C 40 20, 60 20, 62 60 S 80 95, 100 55 S 130 15, 140 60 C 146 80, 160 80, 172 50 C 180 30, 196 30, 200 62 S 230 80, 260 40 L 300 58"
const consentimientos = scripted(
  "Consentimientos",
  "Carmen Alva · retiro de lunar",
  "ms-cons",
  `<div class="ms-doc">
    <b>Consentimiento informado · Retiro de lunar</b>
    <span class="ln"></span><span class="ln"></span><span class="ln s"></span>
    <span class="ms-check" data-s="k1"><i></i>Me explicaron el procedimiento y sus riesgos.</span>
    <span class="ms-check" data-s="k2"><i></i>Sé que puedo hacer preguntas antes de firmar.</span>
    <div class="ms-sigbox"><svg class="ms-sig" data-s="sig" viewBox="0 0 320 110" aria-hidden="true"><path d="${SIGN}"/></svg><small>Firma de Carmen Alva</small></div>
  </div>
  <div class="ms-bar"><span class="ms-k ms-in" data-s="who">Firmó en la sala 1 · 10:12 · confirmó la Dra. Elena Vela</span><span class="ms-in" data-s="ok">${pill("Firmado", "green")}</span></div>`,
  [[500, "[data-s=k1]"], [450, "[data-s=k2]"], [400, "[data-s=sig]"], [1700, "[data-s=who]"], [200, "[data-s=ok]"]],
)

const imagenes = scripted(
  "Imágenes",
  "Julia Ramos · Documentos",
  "",
  `<div class="ms-rows">
    ${row("i1", "02 sep", "Ecografía obstétrica · 8 semanas", "Imagen · se abre al lado", pill("Ver"), "on")}
    ${row("i2", "15 ago", "Hemograma completo", "Resultado · laboratorio", pill("Ver"), "on")}
    ${row("i3", "Hoy", "Ecografía obstétrica · 12 semanas", "Subida por recepción · Julia la trajo en su celular", pill("Ver", "teal"))}
  </div>
  <div class="ms-bar"><span class="ms-k">Cada imagen es una fila más de su historia</span><span class="ms-btn ms-in" data-s="cmp">Comparar con la anterior</span></div>`,
  [[600, "[data-s=i3]"], [150, "[data-s=i3]", "hl"], [500, "[data-s=cmp]"], [800, "[data-s=cmp]", "press"]],
)

const controles = scripted(
  "Controles que se repiten",
  "Luis Gómez Salas · control de presión cada 3 meses",
  "",
  `<div class="ms-rows">
    ${row("c1", "ene", "Control de presión", "Vino · 152/96", pill("Hecho"), "on")}
    ${row("c2", "abr", "Control de presión", "Vino · 146/92", pill("Hecho"), "on")}
    ${row("c3", "jul", "Control de presión", "Vino · 138/88", pill("Hecho"), "on")}
    ${row("c4", "oct", "Control de presión", "Le toca esta semana · no tiene cita", `<span data-s="st">${pill("Por avisar", "amber")}</span>`, "on")}
  </div>
  ${toast("Argos lo encontró y Sofi le escribió · Luis reservó el jueves 16:00", "amber")}`,
  [[700, "[data-s=c4]", "low"], [900, "[data-s=st]", "", pill("Sofi le escribió", "teal")], [700, "[data-s=st]", "", pill("Reservó · jue 16:00", "green")], [0, "[data-s=c4]", "-low"], [0, "[data-s=c4]", "hl"], [300, "[data-s=toast]"]],
)

const caja = scripted(
  "Caja y cobros",
  "Rosa Paredes · su cuenta",
  "ms-cash",
  `<div class="ms-rows">
    ${row("r1", "Hoy 09:00", "Consulta · Dra. Elena Vela", "Atendida", `<span class="amt">S/ 80</span>`, "on")}
    ${row("r2", "Hoy 09:25", "Pago · tarjeta", "Recibo 0231", `<span class="amt">− S/ 80</span>`)}
  </div>
  <div class="ms-due"><span>Le falta pagar</span><b data-s="due">S/ 80</b><span class="ms-in" data-s="ok">${pill("Al día", "green")}</span></div>
  ${toast("Comprobante enviado a Rosa por correo; también queda en su enlace")}`,
  [[700, "[data-s=r2]"], [150, "[data-s=r2]", "hl"], [500, "[data-s=due]", "zero", "S/ 0"], [250, "[data-s=ok]"], [500, "[data-s=toast]"]],
)

const enlace = scripted(
  "Su enlace del paciente",
  "Lo que ve Rosa en su celular",
  "ms-portal",
  `<div class="ms-phone">
    <span class="ms-k">Consultorio San Martín</span>
    <b class="hi">Hola, Rosa</b>
    <div class="ms-pcard"><span class="ms-k">Tu próxima cita</span><b>Lunes 27 · 09:00</b><small>Control · Dra. Elena Vela</small><span class="lnk">Cambiar</span></div>
    <div class="ms-pcard" data-s="dec"><span class="ms-k">Tus papeles</span><b data-s="dect">Descanso médico · 3 días</b><span class="ms-btn" data-s="go">Descargar</span></div>
    <div class="ms-pcard"><span class="ms-k">También</span><small>Receta · Comprobante · Tus datos</small></div>
  </div>
  <div class="ms-side">
    <b>Reserva, se registra y ve lo suyo.</b>
    <span>Sin contraseñas ni aplicaciones que instalar.</span>
    <span class="ms-in" data-s="seen">${pill("Ya no te llama para pedir el descanso", "teal")}</span>
  </div>`,
  [[900, "[data-s=go]", "press"], [300, "[data-s=dect]", "", "Descanso médico · descargado"], [10, "[data-s=dec]", "done"], [10, "[data-s=go]", "-press", "Listo"], [500, "[data-s=seen]"]],
)

const canales = scripted(
  "Todos tus canales",
  "Rosa Paredes · una sola conversación",
  "",
  `<div class="ms-rows">
    ${row("m1", "lun 10:02", "Instagram", "«¿Atienden mañana?»", "", "on")}
    ${row("m2", "lun 10:03", "Sofi", "Sí, mañana hay horario a las 9:00 con la Dra. Vela.", "", "on")}
    ${row("m3", "mié 18:20", "WhatsApp", "«Quiero reservar para el lunes»", "")}
    ${row("m4", "mié 18:20", "Sofi", "Te reservé el lunes 27 a las 9:00.", "")}
    ${row("m5", "jue 08:00", "Correo", "Su descanso médico, adjunto", "")}
  </div>
  ${toast("Tres canales, una sola persona y su única historia")}`,
  [[600, "[data-s=m3]"], [500, "[data-s=m4]"], [0, "[data-s=m4]", "hl"], [700, "[data-s=m5]"], [500, "[data-s=toast]"]],
)

const SPARK = "0,60 40,52 80,56 120,40 160,44 200,30 240,34 280,18 320,22 360,8"
const reportes = scripted(
  "Reportes",
  "Todo el consultorio · septiembre frente a agosto",
  "ms-rep",
  `<div class="ms-tiles">
    <div class="ms-tile"><span>Cobrado</span><b>S/ 18.420</b><small>8 % más que en agosto</small><svg class="ms-spark" data-s="sp" viewBox="0 0 360 70" aria-hidden="true"><polyline points="${SPARK}"/></svg></div>
    <div class="ms-tile"><span>Consultas atendidas</span><b>246</b><small>4 % más que en agosto</small></div>
    <div class="ms-tile"><span>Pacientes nuevos</span><b>31</b><small>2 más que en agosto</small></div>
  </div>
  <div class="ms-ask"><span class="ms-k">Pregúntale a Argos ›</span><b data-s="q">&nbsp;</b></div>
  <div class="ms-card ms-in" data-s="ans"><span class="ms-k">Argos</span><b>12 pacientes con hipertensión no vinieron a su control.</b><small>Con «Avisar un control», Sofi les escribe. · Ver la lista</small></div>`,
  [
    [300, "[data-s=sp]"],
    [900, "[data-s=q]", "", "¿Quién no vino"],
    [250, "[data-s=q]", "", "¿Quién no vino a su control"],
    [250, "[data-s=q]", "", "¿Quién no vino a su control de presión?"],
    [800, "[data-s=ans]"],
  ],
)

const equipo = scripted(
  "Sedes, equipo y permisos",
  "Consultorio San Martín",
  "ms-team",
  `<div class="ms-teamg">
    <div class="ms-rows">
      ${row("t1", "", "Dra. Elena Vela", "Médica · Sala 1", "", "on")}
      ${row("t2", "", "Dr. Andrés Ríos", "Médico · Sala 2", "", "on")}
      ${row("t3", "", "Lucía Campos", "Recepción", "", "on")}
      ${row("t4", "", "Diego Soto", "Caja", pill("Invitación enviada", "teal"))}
    </div>
    <div class="ms-card"><span class="ms-k">Lo que ve Recepción</span>
      <span class="ms-perm">Agenda <i>✓</i></span><span class="ms-perm">Conversaciones <i>✓</i></span><span class="ms-perm">Pacientes <i>✓</i></span>
      <span class="ms-perm no" data-s="clin">Historia clínica <i>✕</i></span>
    </div>
  </div>
  <div class="ms-bar"><span class="ms-in" data-s="free">${pill("USD 0 por médico, por sala y por sede", "green")}</span><span class="ms-btn" data-s="inv">Invitar a alguien</span></div>`,
  [[600, "[data-s=inv]", "press"], [300, "[data-s=t4]"], [150, "[data-s=t4]", "hl"], [700, "[data-s=clin]", "flag"], [500, "[data-s=free]"]],
)

registerScreens({
  agenda,
  historia,
  signos,
  examen,
  antecedentes,
  receta,
  descanso,
  ordenes,
  consentimientos,
  imagenes,
  controles,
  caja,
  enlace,
  canales,
  reportes,
  equipo,
})
