// El movimiento de las páginas de los agentes (web v5): Sofi (/sofi) y Argos (/argos). Usan las
// escenas del Inicio (inicio.ts) y suman las suyas. Con «reducir movimiento» nada se fija ni se
// mueve: la página ya está completa (agentes.css) y Sofi queda quieta en su lugar.
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { cargarSofi, chatVivo, cierre, mapa, prepararScroll, trazarMapa, venta } from "./inicio"
import { desde, reduceMovimiento } from "./sitio"
import type { Sofi } from "./sofi"

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

/** La entrada del héroe de un agente: las líneas del título, el texto y su escena. */
function entrada(escena: string) {
  gsap
    .timeline({ defaults: { ease: "expo.out" } })
    .from(
      ".ag-heroe__h .linea > span",
      { yPercent: 115, rotate: 3, duration: 1.4, stagger: 0.1 },
      0.1,
    )
    .from("[data-entra]", { y: 24, opacity: 0, duration: 1.2, stagger: 0.08 }, 0.35)
    // Sin dejar transform al final: así los chats que le llegan pueden ir delante de Sofi.
    .from(escena, { scale: 0.85, opacity: 0, duration: 1.6, clearProps: "transform,opacity" }, 0.2)
  gsap.to(".ag-heroe__texto", {
    yPercent: -12,
    opacity: 0.4,
    ease: "none",
    scrollTrigger: { trigger: "[data-ag-heroe]", start: "top top", end: "bottom top", scrub: true },
  })
}

/** Los chats que le llegan a Sofi en el héroe: entran uno por uno y ella los mira. */
function llegan(sofi: Sofi) {
  const items = $$("[data-llega]")
  if (!items.length) return
  gsap.set(items, { opacity: 0, scale: 0.8, y: 20 })
  const tl = gsap.timeline({ repeat: -1, delay: 1.2 })
  for (const it of items) {
    tl.to(it, { opacity: 1, scale: 1, y: 0, duration: 0.6, ease: "back.out(1.8)" })
    tl.call(() => {
      sofi.mirar(centro(it))
      sofi.hablar()
    })
    tl.to({}, { duration: 1.6 })
  }
  tl.call(() => sofi.mirar(null))
  tl.to(items, { opacity: 0, y: -14, duration: 0.5, stagger: 0.08 }, "+=1.5")
  ScrollTrigger.create({
    trigger: "[data-ag-heroe]",
    start: "top bottom",
    end: "bottom top",
    onToggle: (st) => {
      if (st.isActive) tl.resume()
      else tl.pause()
    },
  })
}

/** Su oficio: las tarjetas pasan de costado mientras la sección se queda fija (en computadora). */
function oficio() {
  const pin = $("[data-oficio-pin]")
  const pista = $("[data-oficio-pista]")
  if (!pin || !pista) return
  ScrollTrigger.matchMedia({
    "(min-width: 1024px)": () => {
      const largo = () => Math.max(0, pista.scrollWidth - window.innerWidth + 80)
      gsap.to(pista, {
        x: () => -largo(),
        ease: "none",
        scrollTrigger: {
          trigger: pin,
          start: "top top",
          end: () => `+=${largo()}`,
          pin: true,
          scrub: 0.6,
          invalidateOnRefresh: true,
        },
      })
    },
    "(max-width: 1023px)": () => {
      gsap.from($$(".oficio__tarjeta", pista), {
        y: 50,
        opacity: 0,
        duration: 1,
        stagger: 0.1,
        ease: "expo.out",
        scrollTrigger: { trigger: pista, start: desde("top 80%") },
      })
    },
  })
}

/** La regla grande: el precio baja hasta lo que pide la clienta, choca y rebota a la oferta. */
function regla(sofi: Sofi) {
  const g = $("[data-regla-g]")
  const punto = $("[data-regla-g-punto]")
  if (!g || !punto) return
  const sofiEl = $(".regla-g__sofi", g)
  gsap
    .timeline({ scrollTrigger: { trigger: g, start: desde("top 70%", "top 75%") } })
    .fromTo(punto, { left: "100%" }, { left: "34.5%", duration: 1.2, ease: "power2.in" })
    .call(() => {
      if (sofiEl) sofi.humor(sofiEl, "decidida")
      sofi.tocar()
    })
    .to(g, { x: -8, duration: 0.06, yoyo: true, repeat: 3 })
    .to(punto, { left: "69%", duration: 0.9, ease: "back.out(2.2)" })
    .call(() => {
      if (sofiEl) sofi.humor(sofiEl, "feliz")
      sofi.festejar()
    })
    .from(".regla-g__marca--oferta", { opacity: 0, y: 10, duration: 0.5 }, "-=0.4")
}

export function iniciarSofi() {
  const quieta = reduceMovimiento()
  const lineas = trazarMapa()
  const sofi = cargarSofi(quieta)
  chatVivo(sofi, quieta)
  if (quieta) return
  prepararScroll()
  entrada(".ag-heroe__escena")
  llegan(sofi)
  oficio()
  mapa(sofi, lineas)
  venta(sofi)
  regla(sofi)
  gsap.from(".humor__cara", {
    y: 60,
    rotate: (i: number) => (i - 1) * 8,
    opacity: 0,
    duration: 1.2,
    stagger: 0.12,
    ease: "back.out(1.6)",
    scrollTrigger: { trigger: ".humores__lista", start: desde("top 80%") },
  })
  cierre()
}

/** El radar del héroe: los avisos de Argos aparecen alrededor, uno por uno, en bucle. */
function radar() {
  const avisos = $$("[data-aviso-r]")
  if (!avisos.length) return
  gsap.set(avisos, { opacity: 0, scale: 0.7 })
  const tl = gsap.timeline({ repeat: -1, delay: 1 })
  for (const a of avisos) {
    tl.to(a, { opacity: 1, scale: 1, duration: 0.55, ease: "back.out(2)" })
    tl.fromTo($("i", a), { scale: 2.6, opacity: 0.2 }, { scale: 1, opacity: 1, duration: 0.6 }, "<")
    tl.to({}, { duration: 1.1 })
  }
  tl.to(avisos, { opacity: 0, scale: 0.85, duration: 0.5, stagger: 0.06 }, "+=1.8")
  ScrollTrigger.create({
    trigger: "[data-ag-heroe]",
    start: "top bottom",
    end: "bottom top",
    onToggle: (st) => {
      if (st.isActive) tl.resume()
      else tl.pause()
    },
  })
}

/** Un día con Argos: la escena se queda fija y avanza hora por hora con el scroll. */
function dia(sofi: Sofi) {
  const pin = $("[data-dia-pin]")
  if (!pin) return
  const eventos = $$("[data-evento]", pin)
  const hora = $("[data-dia-hora]", pin)
  const avance = $("[data-dia-avance]", pin)
  const sofiEl = $(".dia__sofi", pin)
  gsap.set(eventos, { opacity: 0, x: 40 })
  let visto = -1
  const mostrar = (n: number) => {
    if (n === visto) return
    for (const [i, e] of eventos.entries()) {
      if (i <= n && i > visto) gsap.to(e, { opacity: 1, x: 0, duration: 0.6, ease: "expo.out" })
      if (i > n && i <= visto) gsap.to(e, { opacity: 0, x: 40, duration: 0.3 })
      e.classList.toggle("es-ahora", i === n)
    }
    visto = n
    const e = eventos[n]
    if (!e) return
    if (hora) hora.textContent = $(".evento__hora", e)?.textContent ?? ""
    if (e.classList.contains("evento--sofi")) {
      if (sofiEl) sofi.humor(sofiEl, "atenta")
      sofi.hablar()
      sofi.mirar(centro(e))
    } else {
      if (sofiEl) sofi.humor(sofiEl, "curiosa")
      sofi.mirar(centro(e))
    }
  }
  mostrar(0)
  const escritorio = window.innerWidth >= 1024
  ScrollTrigger.create({
    trigger: pin,
    start: "top top",
    end: () => `+=${window.innerHeight * (escritorio ? 3 : 3.4)}`,
    pin: true,
    anticipatePin: 1,
    invalidateOnRefresh: true,
    onUpdate: (st) => {
      const n = Math.min(eventos.length - 1, Math.floor(st.progress * eventos.length))
      mostrar(n)
      if (avance) gsap.set(avance, { scaleX: st.progress })
    },
    onLeave: () => {
      if (sofiEl) sofi.humor(sofiEl, "feliz")
      sofi.festejar()
      sofi.mirar(null)
    },
  })
}

/** Lo que hace Argos: cada tarjeta con su animación al verse. */
function poderes() {
  const en = (sel: string) => ({ trigger: sel, start: desde("top 78%") })
  gsap.from(".poder", {
    y: 60,
    opacity: 0,
    duration: 1.1,
    stagger: 0.12,
    ease: "expo.out",
    scrollTrigger: en(".poderes__grilla"),
  })
  gsap.from(".poder__mensajes li", {
    x: -30,
    opacity: 0,
    duration: 0.7,
    stagger: 0.22,
    ease: "back.out(1.6)",
    scrollTrigger: en(".poder--vende"),
  })
  // El stock baja de 6 a 0, aparece «Reponer», entra mercadería y vuelve a 6.
  const n = $("[data-stock-n]")
  const barra = $("[data-stock-barra]")
  const reponer = $("[data-stock-reponer]")
  if (n && barra && reponer) {
    const v = { u: 6 }
    gsap.set(reponer, { opacity: 0, y: 10 })
    gsap
      .timeline({ repeat: -1, repeatDelay: 1.2, scrollTrigger: en(".poder--stock") })
      .to(v, {
        u: 0,
        duration: 2.4,
        ease: "steps(6)",
        onUpdate: () => {
          n.textContent = String(Math.round(v.u))
          barra.style.transform = `scaleX(${v.u / 6})`
        },
      })
      .to(reponer, { opacity: 1, y: 0, duration: 0.5, ease: "back.out(2)" })
      .to({}, { duration: 1.4 })
      .to(v, {
        u: 6,
        duration: 0.8,
        ease: "power2.out",
        onUpdate: () => {
          n.textContent = String(Math.round(v.u))
          barra.style.transform = `scaleX(${v.u / 6})`
        },
      })
      .to(reponer, { opacity: 0, y: -10, duration: 0.4 }, "<")
  }
  gsap.from("[data-barra]", {
    scaleX: 0,
    duration: 1.2,
    stagger: 0.12,
    ease: "expo.out",
    scrollTrigger: en(".poder--conoce"),
  })
  gsap.from(".toca li", {
    y: 30,
    opacity: 0,
    duration: 0.7,
    stagger: 0.18,
    ease: "back.out(1.6)",
    scrollTrigger: en(".poder--ordena"),
  })
}

/** Argos, Sofi y tu equipo: las líneas se dibujan entre los tres. */
function equipo() {
  const e = $("[data-equipo]")
  if (!e) return
  const apilado = window.innerWidth < 860
  gsap
    .timeline({ scrollTrigger: { trigger: e, start: desde("top 75%") } })
    .from($$(".equipo__agente", e), {
      y: 40,
      opacity: 0,
      duration: 0.9,
      stagger: 0.25,
      ease: "expo.out",
    })
    .from(
      "[data-equipo-linea]",
      { [apilado ? "scaleY" : "scaleX"]: 0, duration: 0.8, stagger: 0.25, ease: "power2.inOut" },
      "-=0.6",
    )
}

export function iniciarArgos() {
  const quieta = reduceMovimiento()
  const sofi = cargarSofi(quieta)
  if (quieta) return
  prepararScroll()
  entrada("[data-radar-g]")
  radar()
  dia(sofi)
  poderes()
  equipo()
  cierre()
}
