// Lo común a todas las páginas (web v5): el scroll suave (Lenis), la cabecera que pasa de
// transparente a blanca al bajar, la hoja del menú en el celular y lo que entra al verse
// (`[data-aparece]`). Con «reducir movimiento» no hay scroll suave y todo está a la vista.
import Lenis from "lenis"

let lenis: Lenis | null = null

/** El scroll suave de la página, si lo hay (no con «reducir movimiento»). */
export function scrollSuave(): Lenis | null {
  return lenis
}

export const reduceMovimiento = (): boolean =>
  matchMedia("(prefers-reduced-motion: reduce)").matches

function cabecera() {
  const header = document.querySelector<HTMLElement>("[data-cabecera]")
  if (!header) return
  let solida = false
  const revisar = () => {
    const ahora = window.scrollY > 24
    if (ahora !== solida) {
      solida = ahora
      header.classList.toggle("es-solida", ahora)
    }
  }
  revisar()
  window.addEventListener("scroll", revisar, { passive: true })
}

function menu() {
  const hoja = document.querySelector<HTMLElement>("[data-hoja]")
  const abrir = document.querySelector<HTMLButtonElement>("[data-abrir-menu]")
  if (!hoja || !abrir) return
  const cerrar = () => {
    hoja.classList.remove("esta-abierta")
    abrir.setAttribute("aria-expanded", "false")
    lenis?.start()
    document.body.style.overflow = ""
    window.setTimeout(() => {
      if (!hoja.classList.contains("esta-abierta")) hoja.hidden = true
    }, 400)
    abrir.focus()
  }
  abrir.addEventListener("click", () => {
    hoja.hidden = false
    requestAnimationFrame(() => hoja.classList.add("esta-abierta"))
    abrir.setAttribute("aria-expanded", "true")
    lenis?.stop()
    document.body.style.overflow = "hidden"
    hoja.querySelector<HTMLElement>("[data-cerrar-menu]")?.focus()
  })
  for (const b of hoja.querySelectorAll("[data-cerrar-menu]")) b.addEventListener("click", cerrar)
  hoja.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cerrar()
    if (e.key !== "Tab") return
    // El foco no sale de la hoja mientras está abierta.
    const focos = [...hoja.querySelectorAll<HTMLElement>("a, button")]
    const primero = focos[0]
    const ultimo = focos[focos.length - 1]
    if (e.shiftKey && document.activeElement === primero) {
      e.preventDefault()
      ultimo?.focus()
    } else if (!e.shiftKey && document.activeElement === ultimo) {
      e.preventDefault()
      primero?.focus()
    }
  })
}

function aparecer() {
  const items = document.querySelectorAll<HTMLElement>("[data-aparece]")
  if (!items.length) return
  if (reduceMovimiento() || !("IntersectionObserver" in window)) {
    for (const el of items) el.classList.add("visto")
    return
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        e.target.classList.add("visto")
        io.unobserve(e.target)
      }
    },
    { rootMargin: "0px 0px -12% 0px" },
  )
  for (const el of items) io.observe(el)
}

/** Lo que dice Sofi cuando la tocan: una frase por toque, en orden. */
export const FRASES_DE_SOFI = [
  "¡Hola! Soy Sofi. Vendo por ti, a toda hora.",
  "Tú duermes, yo atiendo. Tú empacas, yo cobro.",
  "Nunca bajo de tu mínimo. Palabra de Sofi.",
  "Una sola oferta, con plazo. Así se cierra una venta.",
  "WhatsApp, Instagram y Messenger: yo contesto los tres.",
  "¿Vendemos juntas? Escríbenos y te muestro cómo.",
]

/**
 * Tocar a Sofi: un globo con su frase aparece sobre ella y se va solo. Con el mouse o el dedo, el
 * rebote lo hace sofi.ts al tocarla; con el teclado (Enter o espacio), este botón se lo pide.
 */
function sofiHabla() {
  let n = 0
  for (const boton of document.querySelectorAll<HTMLButtonElement>("[data-sofi-toque]")) {
    const globo = boton.parentElement?.querySelector<HTMLElement>("[data-sofi-dice]")
    if (!globo) continue
    let reloj = 0
    boton.addEventListener("click", (e) => {
      if (e.detail === 0) window.dispatchEvent(new CustomEvent("sofi:tocar"))
      globo.textContent = FRASES_DE_SOFI[n % FRASES_DE_SOFI.length] ?? ""
      n++
      globo.classList.remove("es-visible")
      void globo.offsetWidth
      globo.classList.add("es-visible")
      window.clearTimeout(reloj)
      reloj = window.setTimeout(() => globo.classList.remove("es-visible"), 4200)
    })
  }
}

export function iniciarSitio() {
  if (!reduceMovimiento()) {
    lenis = new Lenis({ duration: 1.15, smoothWheel: true, wheelMultiplier: 0.95 })
    const bucle = (t: number) => {
      lenis?.raf(t)
      requestAnimationFrame(bucle)
    }
    requestAnimationFrame(bucle)
    // Los enlaces a una parte de la página también bajan con suavidad.
    document.addEventListener("click", (e) => {
      const a = (e.target as Element).closest<HTMLAnchorElement>('a[href*="#"]')
      if (!a || a.origin !== location.origin || a.pathname !== location.pathname || !a.hash) return
      const destino = document.querySelector(a.hash)
      if (!destino) return
      e.preventDefault()
      lenis?.scrollTo(destino as HTMLElement, { offset: -72 })
      history.pushState(null, "", a.hash)
    })
  }
  cabecera()
  menu()
  aparecer()
  sofiHabla()
  // Sofi está en el cierre de todas las páginas; la que la carga ella misma lo marca (`data-sofi-propia`).
  if (
    !document.documentElement.hasAttribute("data-sofi-propia") &&
    document.querySelector("[data-sofi]")
  )
    import("./sofi").then((m) => m.crearSofi(reduceMovimiento()))
}
