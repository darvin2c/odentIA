// El movimiento del Inicio (web v5), con GSAP y ScrollTrigger sobre el scroll suave de Lenis:
// - el héroe entra por líneas y su demo cuenta una venta en un bucle que se puede pausar;
// - cada sección entra o avanza con el scroll, y Sofi (src/scripts/sofi.ts) la recorre;
// - la venta de punta a punta es una escena fija que avanza paso a paso.
// Con «reducir movimiento» no corre nada de esto: la página ya está completa y quieta (inicio.css),
// y Sofi se dibuja quieta en su lugar.
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { CHAT_VIVO } from "../lib/venta"
import { reduceMovimiento, scrollSuave } from "./sitio"
import type { Humor, Sofi } from "./sofi"

gsap.registerPlugin(ScrollTrigger)

const $ = <T extends Element = HTMLElement>(s: string, raiz: ParentNode = document) =>
  raiz.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string, raiz: ParentNode = document) => [
  ...raiz.querySelectorAll<T>(s),
]

const centro = (el: Element) => {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** Las líneas del mapa «Sofi conoce tu tienda», de cada fuente a Sofi y de Sofi a lo que hace. */
function trazarMapa(): SVGPathElement[] {
  const mapa = $("[data-mapa]")
  const svg = $<SVGSVGElement>("[data-mapa-lineas]")
  const nucleo = $(".mapa__centro")
  if (!mapa || !svg || !nucleo) return []
  const dibujar = () => {
    const m = mapa.getBoundingClientRect()
    const c = nucleo.getBoundingClientRect()
    const cx = c.left + c.width / 2 - m.left
    const cy = c.top + c.height / 2 - m.top
    const radio = c.width * 0.33
    const apilado = getComputedStyle(mapa).gridTemplateColumns.split(" ").length < 3
    let html =
      '<defs><linearGradient id="mapa-degradado" x1="0" x2="1"><stop offset="0" stop-color="#ffb27a"/><stop offset="1" stop-color="#cc4604"/></linearGradient></defs>'
    const linea = (d: string, i: string) =>
      `<path class="base" d="${d}"/><path class="trazo" data-linea="${i}" d="${d}"/>`
    for (const chip of $$("[data-fuente]", mapa)) {
      const r = chip.getBoundingClientRect()
      if (apilado) {
        const x = r.left + r.width / 2 - m.left
        const y = r.bottom - m.top
        html += linea(
          `M${x},${y} C${x},${(y + cy) / 2} ${cx},${cy - radio - 40} ${cx},${cy - radio}`,
          `f${chip.dataset.fuente}`,
        )
      } else {
        const x = r.right - m.left
        const y = r.top + r.height / 2 - m.top
        const ang = Math.atan2(y - cy, x - cx)
        const ex = cx + Math.cos(ang) * radio
        const ey = cy + Math.sin(ang) * radio
        const mx = (x + ex) / 2
        html += linea(`M${x},${y} C${mx},${y} ${mx},${ey} ${ex},${ey}`, `f${chip.dataset.fuente}`)
      }
    }
    for (const chip of $$("[data-hace]", mapa)) {
      const r = chip.getBoundingClientRect()
      if (apilado) {
        const x = r.left + r.width / 2 - m.left
        const y = r.top - m.top
        if (chip.dataset.hace !== "0") continue
        html += linea(
          `M${cx},${cy + radio} C${cx},${cy + radio + 30} ${x},${y - 30} ${x},${y}`,
          `h${chip.dataset.hace}`,
        )
      } else {
        const x = r.left - m.left
        const y = r.top + r.height / 2 - m.top
        const ang = Math.atan2(y - cy, x - cx)
        const sx = cx + Math.cos(ang) * radio
        const sy = cy + Math.sin(ang) * radio
        const mx = (x + sx) / 2
        html += linea(`M${sx},${sy} C${mx},${sy} ${mx},${y} ${x},${y}`, `h${chip.dataset.hace}`)
      }
    }
    svg.innerHTML = html
    svg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`)
  }
  dibujar()
  return $$<SVGPathElement>("path.trazo", svg)
}

/** El chat del héroe: la visitante toca una pregunta y Sofi contesta con la respuesta de muestra. */
function chatVivo(sofi: Sofi, quieta: boolean) {
  const caja = $("[data-chat-vivo]")
  const lista = $("[data-chat-lista]")
  const escribe = $("[data-escribe]")
  const estado = $("[data-chat-estado]")
  const sofiEl = $("[data-sofi-chat]")
  if (!caja || !lista || !escribe) return
  for (const li of $$("[data-sin-js]", lista)) li.remove()
  const chips = $$<HTMLButtonElement>("[data-pregunta]", caja)
  let ocupada = false
  let minuto = 42
  const sumar = (de: "ella" | "sofi", texto: string) => {
    const li = document.createElement("li")
    li.className = `msj msj--${de}`
    const quien = document.createElement("span")
    quien.className = "sr"
    quien.textContent = de === "ella" ? "Tú:" : "Sofi:"
    const hora = document.createElement("span")
    hora.className = "msj__hora"
    hora.setAttribute("aria-hidden", "true")
    hora.textContent = `9:${minuto}`
    li.append(quien, texto, hora)
    lista.insertBefore(li, escribe)
    if (!quieta)
      gsap.from(li, { opacity: 0, y: 14, scale: 0.94, duration: 0.5, ease: "back.out(1.6)" })
    // Se ven los últimos mensajes: los de arriba se van.
    const msjs = $$(".msj", lista)
    for (const m of msjs.slice(0, Math.max(0, msjs.length - 6))) m.remove()
    if (!quieta) sofi.mirar(centro(li))
    return li
  }
  const preguntar = (i: number) => {
    const p = CHAT_VIVO[i]
    if (!p || ocupada) return
    ocupada = true
    for (const c of chips) {
      c.disabled = true
      c.classList.remove("es-sugerida")
    }
    sumar("ella", p.q)
    escribe.classList.add("esta")
    if (estado) estado.textContent = "escribiendo…"
    if (sofiEl) sofi.humor(sofiEl, "atenta")
    sofi.hablar()
    window.setTimeout(
      () => {
        escribe.classList.remove("esta")
        if (estado) estado.textContent = "en línea"
        sumar("sofi", p.a)
        if (sofiEl) sofi.humor(sofiEl, p.humor)
        if (p.humor === "feliz") sofi.festejar()
        minuto++
        ocupada = false
        for (const c of chips) c.disabled = false
        chips[(i + 1) % chips.length]?.classList.add("es-sugerida")
        window.setTimeout(() => sofi.mirar(null), 1200)
      },
      quieta ? 300 : 1300,
    )
  }
  for (const c of chips) c.addEventListener("click", () => preguntar(Number(c.dataset.pregunta)))
  chips[0]?.classList.add("es-sugerida")
  $("[data-reiniciar]", caja)?.addEventListener("click", () => {
    for (const m of $$(".msj", lista).slice(1)) m.remove()
    minuto = 42
    if (sofiEl) sofi.humor(sofiEl, "atenta")
    for (const c of chips) c.classList.remove("es-sugerida")
    chips[0]?.classList.add("es-sugerida")
  })
}

function heroe() {
  const t0 = gsap.timeline({ defaults: { ease: "expo.out" } })
  t0.from(
    ".heroe__h .linea > span",
    { yPercent: 115, rotate: 3, duration: 1.4, stagger: 0.09 },
    0.1,
  )
    .from("[data-entra]", { y: 24, opacity: 0, duration: 1.2, stagger: 0.08 }, 0.35)
    .from(".chat__tarjeta", { scale: 0.85, opacity: 0, rotate: -4, duration: 1.6 }, 0.2)
    .from(".chat__cel", { y: 80, rotateX: 16, rotateY: -12, opacity: 0, duration: 1.8 }, 0.3)
    .from(".chat__panel", { y: 30, opacity: 0, duration: 1.2 }, 0.8)
  // Al bajar, el texto sube y se apaga un poco y la tarjeta naranja se queda atrás.
  const st = { trigger: ".heroe", start: "top top", end: "bottom top", scrub: true }
  gsap.to("[data-heroe-texto]", { yPercent: -14, opacity: 0.35, ease: "none", scrollTrigger: st })
  gsap.to(".chat__tarjeta", { yPercent: 12, rotate: 3, ease: "none", scrollTrigger: st })
  gsap.to(".heroe__luz", { yPercent: 30, ease: "none", scrollTrigger: st })
}

/** Sofi trabajando: los pasos se completan uno por uno y los números cuentan hacia arriba. */
function trabajo(sofi: Sofi) {
  const caja = $("[data-trabajo]")
  if (!caja) return
  const pasos = $$("[data-tpaso]", caja)
  const sofiEl = $(".trabajo__ancla", caja)
  const marcar = (i: number, cual: "pensando" | "listo" | "esperando") => {
    const p = pasos[i]
    if (!p) return
    p.classList.toggle("es-pensando", cual === "pensando")
    p.classList.toggle("es-esperando", cual === "esperando")
    const e = $("[data-testado]", p)
    if (e)
      e.textContent =
        cual === "pensando" ? "Pensando" : cual === "esperando" ? "Esperando" : "Listo"
  }
  for (const i of pasos.keys()) marcar(i, "esperando")
  const tl = gsap.timeline({ scrollTrigger: { trigger: caja, start: "top 70%" } })
  tl.from([...caja.children], { y: 50, opacity: 0, duration: 1.1, stagger: 0.12, ease: "expo.out" })
  for (const [i, p] of pasos.entries()) {
    tl.call(() => {
      marcar(i, "pensando")
      sofi.mirar(centro(p))
      sofi.hablar()
      if (sofiEl) sofi.humor(sofiEl, i === 2 ? "decidida" : "atenta")
    })
    tl.call(() => marcar(i, "listo"), [], "+=0.9")
  }
  tl.call(() => {
    if (sofiEl) sofi.humor(sofiEl, "feliz")
    sofi.festejar()
    sofi.mirar(null)
  })
  for (const b of $$("[data-cifra]", caja)) {
    const fin = Number(b.dataset.cifra)
    const n = { v: 0 }
    gsap.to(n, {
      v: fin,
      duration: 1.6,
      ease: "power3.out",
      scrollTrigger: { trigger: caja, start: "top 70%" },
      onUpdate: () => {
        b.textContent = String(Math.round(n.v))
      },
    })
  }
}

/** «Sofi hace, tú decides»: las dos cajas llegan de los costados y el puente se dibuja. */
function decides() {
  const g = $("[data-decides]")
  if (!g) return
  const cajas = $$(".decides__caja", g)
  const apilado = matchMedia("(max-width: 860px)").matches
  const desde = (x: number) => ({
    x: apilado ? 0 : x,
    y: apilado ? 40 : 0,
    opacity: 0,
    duration: 1.1,
    ease: "expo.out",
  })
  gsap
    .timeline({ scrollTrigger: { trigger: g, start: "top 72%" } })
    .from(cajas[0] ?? [], desde(-60))
    .from(
      "[data-puente]",
      { [apilado ? "scaleY" : "scaleX"]: 0, duration: 0.8, ease: "power2.inOut" },
      "-=0.5",
    )
    .from(cajas[1] ?? [], desde(60), "-=0.3")
    .from(
      $$(".lista-ok li", g),
      { x: -12, opacity: 0, duration: 0.5, stagger: 0.05, ease: "expo.out" },
      "-=0.9",
    )
}

function mapa(sofi: Sofi | null, lineas: SVGPathElement[]) {
  const mapaEl = $("[data-mapa]")
  if (!mapaEl) return
  const fuentes = $$("[data-fuente]", mapaEl)
  const hace = $$("[data-hace]", mapaEl)
  const sofiEl = $(".mapa__sofi", mapaEl)
  const preparar = (ls: SVGPathElement[]) => {
    for (const l of ls) {
      const largo = l.getTotalLength()
      l.style.strokeDasharray = `${largo}`
      l.style.strokeDashoffset = `${largo}`
    }
  }
  preparar(lineas)
  gsap.set([...fuentes, ...hace], { opacity: 0.35 })
  let paso = -1
  const total = fuentes.length + hace.length
  const encender = (n: number) => {
    if (n === paso) return
    paso = n
    const svg = $("[data-mapa-lineas]")
    fuentes.forEach((f, i) => {
      const on = i < n
      f.classList.toggle("encendido", i === n - 1)
      gsap.to(f, { opacity: on ? 1 : 0.35, duration: 0.4 })
      const l = svg?.querySelector<SVGPathElement>(`[data-linea="f${i}"]`)
      if (l)
        gsap.to(l, {
          strokeDashoffset: on ? 0 : l.getTotalLength(),
          duration: 0.7,
          ease: "power2.out",
        })
    })
    hace.forEach((h, j) => {
      const on = fuentes.length + j < n
      h.classList.toggle("encendido", fuentes.length + j === n - 1)
      gsap.to(h, { opacity: on ? 1 : 0.35, duration: 0.4 })
      const l = svg?.querySelector<SVGPathElement>(`[data-linea="h${j}"]`)
      if (l)
        gsap.to(l, {
          strokeDashoffset: on ? 0 : l.getTotalLength(),
          duration: 0.7,
          ease: "power2.out",
        })
    })
    const actual = n > 0 ? [...fuentes, ...hace][n - 1] : null
    if (sofi && actual) sofi.mirar(centro(actual))
    if (sofi && sofiEl && n >= total) {
      sofi.humor(sofiEl, "feliz")
      sofi.festejar()
      sofi.mirar(null)
    } else if (sofi && sofiEl) sofi.humor(sofiEl, "atenta")
  }
  ScrollTrigger.create({
    trigger: mapaEl,
    start: "top 70%",
    end: "bottom 45%",
    onUpdate: (st) => encender(Math.min(total, Math.floor(st.progress * (total + 0.999)))),
    onLeave: () => sofi?.mirar(null),
    onLeaveBack: () => {
      encender(0)
      sofi?.mirar(null)
    },
  })
  // Pulsos que viajan por las líneas encendidas.
  const pulsos = () => {
    const svg = $<SVGSVGElement>("[data-mapa-lineas]")
    if (!svg) return
    const ns = "http://www.w3.org/2000/svg"
    $$<SVGPathElement>("path.trazo", svg).forEach((l, i) => {
      const id = `mapa-l${i}`
      l.id = id
      const c = document.createElementNS(ns, "circle")
      c.setAttribute("r", "3.5")
      c.setAttribute("class", "pulso")
      const am = document.createElementNS(ns, "animateMotion")
      am.setAttribute("dur", `${2.2 + (i % 3) * 0.5}s`)
      am.setAttribute("repeatCount", "indefinite")
      am.setAttribute("begin", `${(i * 0.37) % 2}s`)
      const mp = document.createElementNS(ns, "mpath")
      mp.setAttribute("href", `#${id}`)
      am.appendChild(mp)
      c.appendChild(am)
      svg.appendChild(c)
    })
  }
  pulsos()
  let ancho = window.innerWidth
  window.addEventListener("resize", () => {
    if (Math.abs(window.innerWidth - ancho) < 2) return
    ancho = window.innerWidth
    const nuevas = trazarMapa()
    preparar(nuevas)
    const n = paso
    paso = -1
    encender(n)
    pulsos()
  })
}

function venta(sofi: Sofi | null) {
  const seccion = $("[data-venta]")
  const pin = $("[data-venta-pin]")
  const escena = $("[data-venta-escena]")
  if (!seccion || !pin || !escena) return
  const pasos = $$("[data-paso]", seccion)
  const msjs = $$('[data-chat="venta"] .msj', seccion)
  const tarjetas = $$("[data-tarjeta]", escena)
  const estado = $("[data-estado]", escena)
  const sofiEl = $(".venta__sofi", escena)
  const punto = $("[data-regla-punto]", escena)
  const ruta = $<SVGPathElement>("[data-ruta]", escena)
  const avances = pasos.map((p) => $(".paso__avance i", p))
  const ahora = $("[data-ahora]", escena)

  // El celular cabe en el alto que queda (en el celular, entre el título y el paso).
  const ajustar = () => {
    const ancho = window.innerWidth
    if (ancho >= 1024) {
      const kv = Math.min(1, (window.innerHeight - 110) / 620)
      escena.style.setProperty("--kv", kv.toFixed(3))
      escena.style.height = `${600 * kv}px`
    } else {
      escena.style.height = ""
      const alto = escena.clientHeight || window.innerHeight * 0.55
      const kv = Math.max(0.5, Math.min(1, alto / 610, (ancho - 24) / 300))
      escena.style.setProperty("--kv", kv.toFixed(3))
    }
  }
  ajustar()
  window.addEventListener("resize", ajustar)

  gsap.set(msjs, { display: "none" })
  gsap.set(tarjetas, { opacity: 0, y: 24, scale: 0.94, pointerEvents: "none" })
  if (ruta) {
    const largo = ruta.getTotalLength()
    gsap.set(ruta, { strokeDasharray: `${largo}`, strokeDashoffset: largo })
  }

  let actual = -1
  let visibles = 0
  const mostrar = (n: number) => {
    if (n === actual) return
    const antes = actual
    actual = n
    for (const [i, p] of pasos.entries()) p.classList.toggle("activo", i === n)
    const paso = pasos[n]
    if (ahora && paso)
      ahora.textContent = `${String(n + 1).padStart(2, "0")} · ${$("h3", paso)?.textContent ?? ""}`
    const hasta = Number(paso?.dataset.hasta ?? 0)
    // Los mensajes: entran los nuevos, se van los que sobran al volver.
    msjs.forEach((m, i) => {
      if (i < hasta && i >= visibles) {
        gsap.fromTo(
          m,
          { display: "", opacity: 0, y: 16, scale: 0.94 },
          {
            opacity: 1,
            y: 0,
            scale: 1,
            duration: 0.5,
            delay: (i - visibles) * 0.35,
            ease: "back.out(1.5)",
          },
        )
      } else if (i >= hasta) gsap.set(m, { display: "none" })
    })
    visibles = hasta
    // Las tarjetas de cada paso.
    const quiere = (k: number) =>
      (k === 1 && n === 1) || (k === 2 && (n === 2 || n === 3)) || (k === 4 && n === 4)
    for (const t of tarjetas) {
      const k = Number(t.dataset.tarjeta)
      gsap.to(
        t,
        quiere(k)
          ? { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: "expo.out" }
          : { opacity: 0, y: 24, scale: 0.94, duration: 0.35 },
      )
    }
    estado?.classList.toggle("confirmado", n >= 3)
    if (n === 1 && punto) {
      gsap
        .timeline()
        .fromTo(punto, { left: "100%" }, { left: "34.5%", duration: 0.9, ease: "power2.inOut" })
        .to(punto, { left: "69%", duration: 0.8, ease: "back.out(2)" }, "+=0.2")
    }
    if (n === 4 && ruta) gsap.to(ruta, { strokeDashoffset: 0, duration: 1.4, ease: "power2.inOut" })
    if (n < 4 && ruta) gsap.set(ruta, { strokeDashoffset: ruta.getTotalLength() })
    if (sofi && sofiEl && paso) {
      sofi.humor(sofiEl, (paso.dataset.humor as Humor) ?? "atenta")
      if ((n === 3 || n === 5) && n > antes) sofi.festejar()
      const ultimo = msjs[hasta - 1]
      if (ultimo)
        gsap.delayedCall(0.4, () => {
          if (actual === n) sofi.mirar(centro(ultimo))
          gsap.delayedCall(1, () => sofi.mirar(null))
        })
    }
  }

  mostrar(0)
  const largo = () => (window.innerWidth >= 1024 ? 4.2 : 4.6) * window.innerHeight
  const fijo = ScrollTrigger.create({
    trigger: pin,
    start: "top top",
    end: () => `+=${largo()}`,
    pin: true,
    pinSpacing: true,
    anticipatePin: 1,
    invalidateOnRefresh: true,
    onRefresh: ajustar,
    onUpdate: (st) => {
      const p = st.progress * pasos.length
      const n = Math.min(pasos.length - 1, Math.floor(p))
      mostrar(n)
      avances.forEach((a, i) => {
        if (a) gsap.set(a, { scaleY: i < n ? 1 : i === n ? p - n : 0 })
      })
    },
  })
  // «Verlo en el teléfono» lleva el scroll al medio de ese capítulo.
  for (const b of $$<HTMLButtonElement>("[data-ir-paso]", seccion)) {
    b.addEventListener("click", () => {
      const i = Number(b.dataset.irPaso)
      const y = fijo.start + ((i + 0.5) / pasos.length) * (fijo.end - fijo.start)
      const lenis = scrollSuave()
      if (lenis) lenis.scrollTo(y, { duration: 1.2 })
      else window.scrollTo({ top: y })
    })
  }
  // El celular entra con un leve giro.
  gsap.from(".venta__cel", {
    rotateY: -14,
    rotateX: 8,
    y: 60,
    opacity: 0,
    duration: 1.4,
    ease: "expo.out",
    scrollTrigger: { trigger: seccion, start: "top 70%" },
  })
}

function cobro(sofi: Sofi | null) {
  const escena = $("[data-cobro]")
  if (!escena) return
  const a = $(".cobro__pantalla--a", escena)
  const b = $(".cobro__pantalla--b", escena)
  const linea = $("[data-cobro-linea]", escena)
  const toque = $(".cobro__toque", escena)
  const onda = $(".hojita__onda", escena)
  const sofiEl = $(".cobro__sofi", escena)
  if (sofi && sofiEl) sofi.humor(sofiEl, "atenta")
  const apilado = matchMedia("(max-width: 900px)").matches
  const tl = gsap.timeline({ scrollTrigger: { trigger: escena, start: "top 68%" } })
  tl.from(a, { x: -60, rotateY: 14, opacity: 0, duration: 1.2, ease: "expo.out" })
    .from(
      linea,
      { [apilado ? "scaleY" : "scaleX"]: 0, duration: 0.9, ease: "power2.inOut" },
      "-=0.6",
    )
    .from(toque, { scale: 0.6, opacity: 0, duration: 0.6, ease: "back.out(2.5)" }, "-=0.3")
    .to(toque, { scale: 0.92, duration: 0.12, yoyo: true, repeat: 1 }, "+=0.3")
    .from(b, { x: 60, rotateY: -14, opacity: 0, duration: 1.2, ease: "expo.out" }, "-=0.1")
    .to(onda, { x: "120%", duration: 1.4, ease: "power2.inOut" }, "-=0.6")
    .call(
      () => {
        if (sofi && sofiEl) {
          sofi.humor(sofiEl, "feliz")
          sofi.festejar()
        }
      },
      [],
      "-=1",
    )
}

function argos() {
  gsap.from("[data-alerta]", {
    x: 40,
    opacity: 0,
    duration: 1,
    stagger: 0.18,
    ease: "expo.out",
    scrollTrigger: { trigger: ".argos__lista", start: "top 85%" },
  })
  gsap.fromTo(
    "[data-vitrina]",
    { rotateX: 18, y: 40, scale: 0.94 },
    {
      rotateX: 0,
      y: 0,
      scale: 1,
      ease: "none",
      scrollTrigger: { trigger: "[data-vitrina]", start: "top 98%", end: "top 45%", scrub: 0.6 },
    },
  )
}

function rubros() {
  gsap.from(".rubro", {
    y: 60,
    opacity: 0,
    rotate: (i: number) => (i % 2 ? 3 : -3),
    duration: 1.1,
    stagger: 0.1,
    ease: "expo.out",
    scrollTrigger: { trigger: "[data-rubros-tarjetas]", start: "top 82%" },
  })
  const cintas = $$("[data-cinta]")
  const tweens = cintas.map((c) => {
    const pista = $(".cinta__pista", c)
    const dir = Number(c.dataset.cinta)
    gsap.set(pista, { xPercent: dir > 0 ? 0 : -50 })
    return gsap.to(pista, { xPercent: dir > 0 ? -50 : 0, duration: 38, ease: "none", repeat: -1 })
  })
  // La velocidad del scroll las acelera y las inclina.
  const inclinar = gsap.quickTo(
    cintas.map((c) => $(".cinta__pista", c)),
    "skewX",
    { duration: 0.5, ease: "power3" },
  )
  ScrollTrigger.create({
    trigger: ".rubros",
    start: "top bottom",
    end: "bottom top",
    onToggle: (st) => {
      for (const t of tweens) {
        if (st.isActive) t.play()
        else t.pause()
      }
    },
    onUpdate: (st) => {
      const v = st.getVelocity()
      const f = 1 + Math.min(Math.abs(v) / 400, 5)
      for (const t of tweens)
        gsap.to(t, { timeScale: f * (v < 0 ? -1 : 1), duration: 0.3, overwrite: true })
      inclinar(Math.max(-10, Math.min(10, -v / 220)))
      gsap.delayedCall(0.2, () => {
        for (const t of tweens) gsap.to(t, { timeScale: 1, duration: 1.2, overwrite: true })
        inclinar(0)
      })
    },
  })
}

function precio() {
  const plan = $("[data-plan]")
  const cifra = $("[data-cuenta]")
  if (!plan || !cifra) return
  const n = { v: 0 }
  const tl = gsap.timeline({ scrollTrigger: { trigger: plan, start: "top 75%" } })
  tl.from(plan, { y: 60, scale: 0.96, opacity: 0, duration: 1.3, ease: "expo.out" })
    .to(
      n,
      {
        v: 19,
        duration: 1.4,
        ease: "power3.out",
        onUpdate: () => (cifra.textContent = String(Math.round(n.v))),
      },
      "-=0.9",
    )
    .from(
      $$(".plan__lista li", plan),
      { x: -14, opacity: 0, duration: 0.6, stagger: 0.06, ease: "expo.out" },
      "-=1.2",
    )
}

function cierre() {
  gsap.from(".cierre__sofi", {
    scale: 0.4,
    opacity: 0,
    duration: 1.4,
    ease: "elastic.out(1, 0.6)",
    scrollTrigger: { trigger: ".cierre", start: "top 70%" },
  })
}

export function iniciarInicio() {
  const quieta = reduceMovimiento()
  const lineas = trazarMapa()
  // three.js pesa: Sofi se carga aparte, sin frenar lo demás. Mientras llega, lo que se le pide
  // no hace nada.
  let real: Sofi | null = null
  const sofi: Sofi = {
    humor: (el, h) => real?.humor(el, h),
    mirar: (p) => real?.mirar(p),
    festejar: () => real?.festejar(),
    tocar: () => real?.tocar(),
    hablar: () => real?.hablar(),
  }
  import("./sofi").then((m) => {
    real = m.crearSofi(quieta)
  })
  chatVivo(sofi, quieta)
  const puntos = $<HTMLCanvasElement>("[data-puntos]")
  if (puntos) import("./puntos").then((m) => m.marDePuntos(puntos, quieta))
  if (quieta) return

  const lenis = scrollSuave()
  if (lenis) lenis.on("scroll", ScrollTrigger.update)

  heroe()
  trabajo(sofi)
  mapa(sofi, lineas)
  venta(sofi)
  cobro(sofi)
  decides()
  argos()
  rubros()
  precio()
  cierre()
  // Las fuentes y las imágenes cambian los altos: se recalcula al terminar de cargar.
  window.addEventListener("load", () => ScrollTrigger.refresh())
  document.fonts?.ready.then(() => ScrollTrigger.refresh())
}
