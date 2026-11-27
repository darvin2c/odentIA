/**
 * El movimiento del Inicio (web v4). Cada animación cuenta un tramo de la venta:
 * - Lenis: el scroll suave, para que las escenas guiadas por el scroll se lean sin tirones.
 * - Héroe: el chat de WhatsApp entra mensaje por mensaje («escribiendo…» antes de cada respuesta) y,
 *   al lado, lo que Sofi hizo en la app; se pausa con su botón y fuera de la pantalla.
 * - Del héroe a la venta: el héroe queda atrás, se encoge y se apaga, y la venta sube encima como
 *   una hoja.
 * - La venta: una escena fija que avanza con el scroll (ScrollTrigger con scrub). El paquete en 3D
 *   recibe la zapatilla, se cierra con el pago confirmado, se sella y sale; las tarjetas cuentan el
 *   mismo tramo (el mensaje, el producto, la oferta que se detiene antes del mínimo, el pedido, el
 *   pago confirmado, la ruta).
 * - Pedidos: la pantalla real se levanta de acostada a derecha y señala lo que importa.
 * - La regla de las entregas: el pedido por confirmar sube girando (la frase la pinta el momento
 *   word-highlight de tasteskill).
 * - La ficha: se descubre con una cortina y sus datos entran uno por uno.
 * - Los rubros: dos cintas de palabras que corren en sentidos opuestos con el scroll.
 * - El precio: la cifra cuenta hasta USD 19 una vez.
 * - El cierre: el paquete sellado flota y sigue el puntero.
 * Con «reducir movimiento» nada de esto corre: el HTML ya está completo y en su lugar.
 */
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import Lenis from "lenis"
import { MENSAJES } from "../lib/venta"
import type { Paquete } from "./paquete3d"

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) =>
  root.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(s),
]

export function iniciar(): void {
  const reducido = matchMedia("(prefers-reduced-motion: reduce)").matches
  document.documentElement.classList.add(reducido ? "v4-quieto" : "v4-vivo")
  if (reducido) {
    // Sin movimiento: el paquete se dibuja una vez, ya sellado, y nada más.
    void paquetes(true)
    return
  }
  gsap.registerPlugin(ScrollTrigger)
  const lenis = scrollSuave()
  heroe()
  ventaEscena()
  pedidos()
  regla()
  ficha()
  rubros(lenis)
  precio()
  void paquetes(false)
  // Las fuentes y las imágenes cambian las alturas: se vuelve a medir cuando terminan.
  addEventListener("load", () => ScrollTrigger.refresh())
}

function scrollSuave(): Lenis {
  const lenis = new Lenis({ lerp: 0.1, smoothWheel: true })
  lenis.on("scroll", ScrollTrigger.update)
  gsap.ticker.add((t) => lenis.raf(t * 1000))
  gsap.ticker.lagSmoothing(0)
  // Los enlaces a una parte del Inicio bajan con el mismo scroll suave, debajo de la cabecera.
  document.addEventListener("click", (e) => {
    const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null
    if (!a) return
    const url = new URL(a.href, location.href)
    if (url.pathname !== location.pathname || !url.hash) return
    const destino = document.getElementById(decodeURIComponent(url.hash.slice(1)))
    if (!destino) return
    e.preventDefault()
    lenis.scrollTo(destino, { offset: url.hash === "#top" ? 0 : -8 })
    history.replaceState(null, "", url.hash)
  })
  return lenis
}

/** El chat del héroe: entra mensaje por mensaje y vuelve a empezar; se pausa con su botón. */
function heroe(): void {
  const wa = $("[data-wa]")
  if (!wa) return
  const lista = $("ol", wa) as HTMLOListElement
  const msgs = $$("[data-msg]", wa)
  const typing = $("[data-wa-typing]", wa) as HTMLElement
  const estado = $("[data-wa-estado]", wa) as HTMLElement
  const hizo = $$("[data-hizo]", wa)
  const boton = $("[data-wa-pausa]", wa) as HTMLButtonElement

  const ocultar = () => {
    for (const m of msgs) m.classList.add("is-oculto")
    typing.classList.remove("is-on")
    for (const h of hizo) h.classList.remove("is-on", "is-hecho")
    lista.scrollTop = 0
  }
  const alFinal = () =>
    gsap.to(lista, {
      scrollTop: () => lista.scrollHeight - lista.clientHeight,
      duration: 0.5,
      ease: "power2.out",
    })

  const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.6, onRepeat: ocultar })
  tl.call(ocultar)
  tl.to({}, { duration: 0.6 })
  MENSAJES.forEach((m, i) => {
    const el = msgs[i]
    if (m.de === "sofi") {
      tl.call(() => {
        typing.classList.add("is-on")
        estado.textContent = "escribiendo…"
        alFinal()
      })
      tl.to({}, { duration: 1.2 })
      tl.call(() => {
        typing.classList.remove("is-on")
        estado.textContent = "en línea"
      })
    }
    tl.call(() => {
      el.classList.remove("is-oculto")
      alFinal()
    })
    tl.fromTo(
      el,
      {
        autoAlpha: 0,
        y: 14,
        scale: 0.94,
        transformOrigin: m.de === "clienta" ? "100% 100%" : "0% 100%",
      },
      { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.6)" },
      "<",
    )
    if (m.hizo) {
      const chip = hizo.find((h) => h.dataset.hizo === String(i))
      tl.call(() => {
        for (const h of hizo)
          if (h.classList.contains("is-on")) h.classList.replace("is-on", "is-hecho")
        chip?.classList.add("is-on")
      })
    }
    tl.to({}, { duration: m.de === "clienta" ? 0.9 : 1.6 })
  })
  tl.to({}, { duration: 2.6 })
  tl.to([...msgs, ...hizo], { autoAlpha: 0, duration: 0.5, stagger: 0.02 })
  tl.set([...msgs, ...hizo], { clearProps: "opacity,visibility" })

  let pausado = false
  const marcar = () => {
    boton.setAttribute("aria-pressed", String(pausado))
    boton.setAttribute("aria-label", pausado ? "Seguir la conversación" : "Pausar la conversación")
  }
  boton.addEventListener("click", () => {
    pausado = !pausado
    marcar()
    pausado ? tl.pause() : tl.play()
  })
  // Corre solo mientras el héroe se ve.
  ScrollTrigger.create({
    trigger: ".v4-hero",
    start: "top bottom",
    end: "bottom top",
    onToggle: (s) => (s.isActive && !pausado ? tl.play() : tl.pause()),
  })

  // La entrada: el teléfono sube de frente y la luz se enciende detrás.
  gsap.from(".wa__phone", {
    y: 90,
    rotateX: 18,
    autoAlpha: 0,
    duration: 1.3,
    ease: "expo.out",
    delay: 0.15,
  })
  gsap.from(".v4-hero__luz", {
    scale: 0.4,
    autoAlpha: 0,
    duration: 2,
    ease: "power2.out",
    stagger: 0.2,
  })
  gsap.from([".v4-hero__nota", ".v4-canales li"], {
    y: 16,
    autoAlpha: 0,
    duration: 0.7,
    ease: "power3.out",
    stagger: 0.06,
    delay: 0.5,
  })

  // Del héroe a la venta: el héroe se queda, se encoge y se apaga; la venta sube encima.
  gsap.to(".v4-hero__wrap", {
    scale: 0.88,
    autoAlpha: 0.15,
    yPercent: 8,
    ease: "none",
    scrollTrigger: { trigger: ".v4-hero", start: "top top", end: "bottom top", scrub: true },
  })
  gsap.to(".v4-hero__fondo", {
    scale: 1.25,
    ease: "none",
    scrollTrigger: { trigger: ".v4-hero", start: "top top", end: "bottom top", scrub: true },
  })
}

let paqueteVenta: Paquete | null = null
let progresoVenta = 0

/** La venta fija: 6 pasos que avanzan con el scroll, el paquete y sus tarjetas. */
function ventaEscena(): void {
  const venta = $("#venta")
  if (!venta) return
  const pasos = $$(".paso", venta)
  const riel = $$(".venta__riel i", venta)
  const tarjeta = (n: number) => $(`[data-tarjeta="${n}"]`, venta) as HTMLElement
  const precio = $("[data-precio]", venta) as HTMLElement
  const medidor = $("[data-medidor]", venta) as HTMLElement
  const estado = $("[data-estado]", venta) as HTMLElement
  const ruta = $("[data-ruta]", venta) as SVGPathElement
  const largo = ruta.getTotalLength()
  const N = pasos.length

  gsap.set(pasos, { autoAlpha: 0, y: 40 })
  gsap.set(pasos[0], { autoAlpha: 1, y: 0 })
  gsap.set($$(".tarjeta", venta), { autoAlpha: 0 })
  gsap.set(ruta, { strokeDasharray: largo, strokeDashoffset: largo })
  gsap.set(riel, { scaleX: 0, transformOrigin: "0 50%" })

  const tl = gsap.timeline({ defaults: { ease: "power3.out", duration: 0.5 } })
  const paso = (i: number) => {
    const t = i
    if (i > 0) {
      tl.to(pasos[i - 1], { autoAlpha: 0, y: -40, duration: 0.35 }, t - 0.2)
      tl.to(pasos[i], { autoAlpha: 1, y: 0, duration: 0.45 }, t - 0.05)
    }
    tl.to(riel[i], { scaleX: 1, ease: "none", duration: 1 }, t)
  }
  for (let i = 0; i < N; i++) paso(i)

  // 1. El mensaje de la clienta entra volando desde el borde.
  tl.fromTo(
    tarjeta(0),
    { autoAlpha: 0, x: 160, rotate: 8, scale: 0.8 },
    { autoAlpha: 1, x: 0, rotate: -2, scale: 1, duration: 0.6, ease: "back.out(1.4)" },
    0.05,
  )
  // 2. El producto del catálogo; el mensaje se hace a un lado.
  tl.to(tarjeta(0), { autoAlpha: 0.35, scale: 0.82, y: -30, duration: 0.4 }, 0.95)
  tl.fromTo(
    tarjeta(1),
    { autoAlpha: 0, y: 60, scale: 0.9 },
    { autoAlpha: 1, y: 0, scale: 1, duration: 0.5 },
    1,
  )
  // 3. La oferta: la cifra baja de 129 y se detiene en 120, antes del mínimo.
  tl.to([tarjeta(0), tarjeta(1)], { autoAlpha: 0, y: -40, duration: 0.35 }, 1.9)
  tl.fromTo(tarjeta(2), { autoAlpha: 0, y: 60 }, { autoAlpha: 1, y: 0, duration: 0.45 }, 2)
  const cifra = { v: 129 }
  tl.to(
    cifra,
    {
      v: 120,
      duration: 0.6,
      ease: "power2.inOut",
      onUpdate: () => (precio.textContent = String(Math.round(cifra.v))),
    },
    2.25,
  )
  tl.fromTo(
    medidor,
    { scaleX: 1 },
    {
      scaleX: (120 - 100) / (129 - 100),
      duration: 0.6,
      ease: "power2.inOut",
      transformOrigin: "0 50%",
    },
    2.25,
  )
  // 4. El pedido: la zapatilla cae al paquete (en 3D) y aparece el pedido anotado.
  tl.to(tarjeta(2), { autoAlpha: 0, y: -40, duration: 0.35 }, 2.9)
  tl.fromTo(tarjeta(3), { autoAlpha: 0, x: 80 }, { autoAlpha: 1, x: 0, duration: 0.5 }, 3.15)
  // 5. El pago confirmado: el estado del pedido cambia, el paquete se cierra y se sella.
  tl.call(() => estado.classList.remove("is-pagado"), [], 3.9)
  tl.to(estado, { scale: 1.15, duration: 0.15, yoyo: true, repeat: 1 }, 4.3)
  tl.call(
    () => {
      const pagado = tl.time() >= 4.4
      estado.classList.toggle("is-pagado", pagado)
      estado.textContent = pagado ? "Pagado" : "Pago por confirmar"
    },
    [],
    4.4,
  )
  // El pago confirmado se siente: una onda naranja sale del paquete al sellarse.
  tl.fromTo(
    ".venta__pulso",
    { scale: 0.2, autoAlpha: 0.9 },
    { scale: 2.6, autoAlpha: 0, duration: 0.6, ease: "power2.out" },
    4.45,
  )
  // 6. Sale: el pedido se va con el paquete y se dibuja la ruta.
  tl.to(tarjeta(3), { autoAlpha: 0, x: 120, duration: 0.4 }, 5.05)
  tl.fromTo(tarjeta(5), { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.4 }, 5.1)
  tl.to(ruta, { strokeDashoffset: 0, duration: 0.8, ease: "none" }, 5.15)
  tl.to({}, { duration: 0.2 }, 5.8)

  ScrollTrigger.create({
    trigger: venta,
    pin: ".venta__pin",
    start: "top top",
    end: () => `+=${innerHeight * (N - 0.2)}`,
    scrub: 0.6,
    animation: tl,
    onUpdate: (s) => {
      progresoVenta = s.progress
      paqueteVenta?.setProgress(s.progress)
      // El estado del pedido sigue al scroll también hacia atrás.
      const pagado = tl.time() >= 4.4
      estado.classList.toggle("is-pagado", pagado)
      estado.textContent = pagado ? "Pagado" : "Pago por confirmar"
    },
  })
}

function pedidos(): void {
  const t = $("[data-tablero]")
  if (!t) return
  gsap.fromTo(
    ".tablero__marco",
    { rotateX: 34, scale: 0.84, y: 90, transformOrigin: "50% 100%" },
    {
      rotateX: 0,
      scale: 1,
      y: 0,
      ease: "none",
      scrollTrigger: { trigger: t, start: "top 95%", end: "top 30%", scrub: true },
    },
  )
  gsap.from($$("[data-nota]", t), {
    autoAlpha: 0,
    scale: 0.6,
    y: 20,
    stagger: 0.15,
    duration: 0.6,
    ease: "back.out(2)",
    scrollTrigger: { trigger: t, start: "top 35%", toggleActions: "play none none reverse" },
  })
}

function regla(): void {
  gsap.fromTo(
    "[data-cel]",
    { y: 220, rotate: 8, scale: 0.9 },
    {
      y: 0,
      rotate: -3,
      scale: 1,
      ease: "none",
      scrollTrigger: {
        trigger: "#entrega",
        start: "top bottom",
        end: "center center",
        scrub: true,
      },
    },
  )
}

function ficha(): void {
  const img = $("[data-cortina]")
  if (!img) return
  gsap.fromTo(
    img,
    { clipPath: "inset(18% 12% 18% 12% round 28px)", scale: 0.94 },
    {
      clipPath: "inset(0% 0% 0% 0% round 28px)",
      scale: 1,
      ease: "none",
      scrollTrigger: { trigger: img, start: "top 90%", end: "top 30%", scrub: true },
    },
  )
  gsap.from($$("[data-datos] li"), {
    autoAlpha: 0,
    x: -30,
    stagger: 0.12,
    duration: 0.5,
    ease: "power3.out",
    scrollTrigger: {
      trigger: "[data-datos]",
      start: "top 85%",
      toggleActions: "play none none reverse",
    },
  })
}

function rubros(lenis: Lenis): void {
  const filas = $$("[data-fila]")
  if (!filas.length) return
  for (const f of filas) {
    const dir = Number(f.dataset.fila)
    gsap.fromTo(
      f,
      { xPercent: dir > 0 ? 0 : -30 },
      {
        xPercent: dir > 0 ? -30 : 0,
        ease: "none",
        scrollTrigger: { trigger: "#rubros", start: "top bottom", end: "bottom top", scrub: true },
      },
    )
  }
  // La velocidad del scroll inclina las cintas un poco: se siente que corren.
  const inclinar = filas.map((f) => gsap.quickTo(f, "skewX", { duration: 0.4, ease: "power3.out" }))
  lenis.on("scroll", ({ velocity }: { velocity: number }) => {
    const v = gsap.utils.clamp(-8, 8, velocity * 0.35)
    for (const q of inclinar) q(-v)
  })
}

function precio(): void {
  const el = $("[data-cuenta]")
  if (!el) return
  const fin = Number(el.dataset.cuenta)
  const v = { n: 0 }
  gsap.to(v, {
    n: fin,
    duration: 1.4,
    ease: "power3.out",
    onUpdate: () => (el.textContent = String(Math.round(v.n))),
    scrollTrigger: { trigger: el, start: "top 85%", once: true },
  })
}

/** Los dos paquetes en 3D: se cargan cuando se acercan a la pantalla. */
async function paquetes(reducido: boolean): Promise<void> {
  const lienzos = $$<HTMLCanvasElement>("canvas[data-paquete]")
  if (!lienzos.length || !("IntersectionObserver" in window)) return
  const io = new IntersectionObserver(
    async (entradas) => {
      for (const e of entradas) {
        if (!e.isIntersecting) continue
        io.unobserve(e.target)
        const canvas = e.target as HTMLCanvasElement
        const modo = canvas.dataset.paquete === "cierre" ? "cierre" : "venta"
        try {
          const { crearPaquete } = await import("./paquete3d")
          const p = crearPaquete(canvas, modo, reducido)
          if (modo === "venta") {
            paqueteVenta = p
            p.setProgress(reducido ? 0.86 : progresoVenta)
          }
          const zona =
            modo === "venta" ? canvas.closest(".venta__escena") : canvas.closest("footer")
          zona?.addEventListener("pointermove", (ev) => {
            const r = canvas.getBoundingClientRect()
            const pe = ev as PointerEvent
            p.setPointer(
              ((pe.clientX - r.left) / r.width) * 2 - 1,
              ((pe.clientY - r.top) / r.height) * 2 - 1,
            )
          })
        } catch {
          // Sin WebGL, la escena se queda con sus tarjetas: la venta se entiende igual.
          canvas.closest(".venta__escena, .cierre3d")?.classList.add("sin-3d")
        }
      }
    },
    { rootMargin: "600px 0px" },
  )
  for (const c of lienzos) io.observe(c)
}
