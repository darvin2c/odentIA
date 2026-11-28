// El movimiento del ARM (web v5): la boleta de un pedido, las tres letras de «Qué es un ARM», el
// duelo con un CRM, los dos teléfonos con un chatbot, la frase grande que se enciende y los títulos
// palabra por palabra. También los seis capítulos de Cómo funciona. Todo con GSAP y ScrollTrigger.
// Con «reducir movimiento» no corre nada: la página ya está completa y quieta (arm.css).
import { gsap } from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { desde, reduceMovimiento } from "./sitio"

gsap.registerPlugin(ScrollTrigger)

const $$ = <T extends Element = HTMLElement>(s: string, raiz: ParentNode = document) => [
  ...raiz.querySelectorAll<T>(s),
]

/**
 * Parte en palabras el texto de un elemento, sin tocar sus etiquetas (la cursiva sigue siendo
 * cursiva): cada palabra queda en `.palabra > span`. Devuelve los `span` de adentro.
 */
function enPalabras(el: Element, mascara: boolean): HTMLElement[] {
  const textos: Text[] = []
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  while (w.nextNode()) textos.push(w.currentNode as Text)
  const dentro: HTMLElement[] = []
  for (const t of textos) {
    const partes = (t.textContent ?? "").split(/(\s+)/)
    const frag = document.createDocumentFragment()
    for (const p of partes) {
      if (!p) continue
      if (/^\s+$/.test(p)) {
        frag.append(document.createTextNode(p))
        continue
      }
      const fuera = document.createElement("span")
      fuera.className = mascara ? "palabra palabra--m" : "palabra"
      const span = document.createElement("span")
      span.textContent = p
      fuera.append(span)
      frag.append(fuera)
      dentro.push(span)
    }
    t.replaceWith(frag)
  }
  return dentro
}

/** El título del héroe entra palabra por palabra; los de cada sección, al llegar a ellos. */
function titulos() {
  const h1 = document.querySelector(".p-heroe h1")
  if (h1)
    gsap.from(enPalabras(h1, true), {
      yPercent: 110,
      duration: 1,
      stagger: 0.06,
      ease: "expo.out",
      delay: 0.15,
    })
  for (const h of $$(".cabeza .titulo-2")) {
    gsap.from(enPalabras(h, true), {
      yPercent: 110,
      duration: 0.9,
      stagger: 0.05,
      ease: "expo.out",
      scrollTrigger: { trigger: h, start: desde("top 85%") },
    })
  }
}

/** La frase grande se enciende palabra a palabra, al ritmo del scroll. */
function golpe() {
  for (const g of $$("[data-golpe]")) {
    const palabras = enPalabras(g, false).map((s) => s.parentElement as HTMLElement)
    gsap.to(palabras, {
      opacity: 1,
      stagger: 0.1,
      ease: "none",
      scrollTrigger: { trigger: g, start: "top 80%", end: "bottom 45%", scrub: 0.5 },
    })
  }
}

/** La boleta de un pedido se imprime línea a línea, y al final caen el total y el sello. */
export function boleta() {
  for (const b of $$("[data-boleta]")) {
    gsap
      .timeline({ scrollTrigger: { trigger: b, start: desde("top 75%", "top 85%") } })
      .from(b, { y: 60, opacity: 0, rotate: -4, duration: 0.9, ease: "expo.out" })
      .from($$("[data-linea-b]", b), { opacity: 0, x: -10, duration: 0.3, stagger: 0.14 }, 0.3)
      .from($$("[data-total-b]", b), { opacity: 0, y: 8, duration: 0.4 })
      .from(
        $$("[data-sello-b]", b),
        { scale: 2.6, opacity: 0, rotate: -30, duration: 0.4, ease: "back.out(2.2)" },
        "+=0.1",
      )
      .to(b, { x: 4, duration: 0.05, yoyo: true, repeat: 3 }, "<+0.3")
  }
}

/** A, R, M: cada letra sube desde su máscara, y su palabra y su texto llegan detrás. */
function letras() {
  const g = document.querySelector("[data-letras]")
  if (!g) return
  const tl = gsap.timeline({ scrollTrigger: { trigger: g, start: desde("top 70%", "top 85%") } })
  for (const [i, l] of $$("[data-letra]", g).entries()) {
    tl.from(
      $$(".letra__g > span", l),
      { yPercent: 110, rotate: 8, duration: 1, ease: "expo.out" },
      i * 0.2,
    ).from(
      $$(".letra__palabra, .letra__texto", l),
      { opacity: 0, y: 14, duration: 0.6, stagger: 0.08 },
      i * 0.2 + 0.35,
    )
  }
  tl.from(
    "[data-letras-linea]",
    { scaleX: 0, transformOrigin: "left center", duration: 1.2, ease: "power2.inOut" },
    0.2,
  )
  // Después, cada letra se mueve a su ritmo con el scroll.
  for (const [i, l] of $$(".letra__g", g).entries())
    gsap.to(l, {
      y: -24 * (i + 1),
      ease: "none",
      scrollTrigger: { trigger: g, start: "top bottom", end: "bottom top", scrub: 0.6 },
    })
}

/**
 * El duelo con un CRM: fila por fila, del lado del CRM cae una tarea «Por hacer» para ti y del lado
 * del ARM se dibuja el visto de quien lo hizo. Al final, las cuentas suben, el lado del CRM tiembla
 * y el del ARM se enciende.
 */
function duelo() {
  const d = document.querySelector<HTMLElement>("[data-duelo]")
  if (!d) return
  const filas = $$("[data-duelo-fila]", d)
  const tl = gsap.timeline({ scrollTrigger: { trigger: d, start: desde("top 65%", "top 85%") } })
  tl.from($$("[data-duelo-msg]", d), {
    y: 30,
    opacity: 0,
    scale: 0.9,
    duration: 0.6,
    ease: "back.out(1.8)",
  })
  for (const [i, f] of filas.entries()) {
    const t = 0.5 + i * 0.38
    tl.from($$(".duelo__paso", f), { opacity: 0, x: -10, duration: 0.3 }, t)
      .from(
        $$(".duelo__celda--otro", f),
        { y: -30, opacity: 0, rotate: -2, duration: 0.45, ease: "bounce.out" },
        t,
      )
      .from(
        $$(".duelo__celda--otro .duelo__tag", f),
        { scale: 0, rotate: -20, duration: 0.35, ease: "back.out(3)" },
        t + 0.3,
      )
      .from(
        $$(".duelo__celda--arm", f),
        { x: 40, opacity: 0, duration: 0.45, ease: "expo.out" },
        t + 0.1,
      )
      .from($$(".duelo__visto", f), { scale: 0, duration: 0.3, ease: "back.out(3)" }, t + 0.3)
      .from($$(".duelo__visto path", f), { strokeDashoffset: 24, duration: 0.3 }, t + 0.4)
  }
  tl.addLabel("fin")
  for (const n of $$<HTMLElement>("[data-cuenta-d]", d)) {
    const fin = Number(n.dataset.cuentaD)
    const o = { v: 0 }
    tl.to(
      o,
      {
        v: fin,
        duration: 1,
        ease: "power2.out",
        onUpdate: () => {
          n.textContent = String(Math.round(o.v))
        },
      },
      "fin",
    )
  }
  tl.from($$("[data-duelo-fin]", d), { y: 20, opacity: 0, duration: 0.5, stagger: 0.12 }, "fin")
    .to($$(".duelo__fila--fin .duelo__celda--otro", d), {
      x: 6,
      duration: 0.06,
      yoyo: true,
      repeat: 5,
    })
    .fromTo(
      $$(".duelo__fila--fin .duelo__celda--arm", d),
      { scale: 1 },
      {
        scale: 1.04,
        boxShadow: "0 30px 70px -20px rgba(254, 79, 2, 0.7)",
        duration: 0.35,
        yoyo: true,
        repeat: 1,
        ease: "power2.out",
      },
      "<",
    )
}

/**
 * Dos teléfonos, la misma clienta: los mensajes llegan a la vez a los dos; el chatbot contesta con su
 * menú y Sofi vende. Antes de cada respuesta, «escribiendo»; con cada una, su nota. Después del chat,
 * la lista de cada lado: la de Sofi se marca sola. Al final, el chatbot se apaga y Sofi se adelanta.
 */
function telefonos() {
  const t = document.querySelector<HTMLElement>("[data-telefonos]")
  if (!t) return
  const celular = window.matchMedia("(max-width: 860px)").matches
  gsap.from($$("[data-tel-escena]", t), {
    y: 20,
    opacity: 0,
    duration: 0.6,
    ease: "expo.out",
    scrollTrigger: { trigger: t, start: desde("top 70%") },
  })
  // En computadora los dos teléfonos van juntos; en el celular, cada uno arranca al aparecer.
  const grupos = celular ? $$("[data-tel-lado]", t) : [t]
  for (const g of grupos) {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: g, start: celular ? "top 75%" : "top 55%" },
    })
    const turnos = Math.max(
      ...$$<HTMLElement>("[data-turno]", g).map((m) => Number(m.dataset.turno)),
    )
    const puntos = $$(".tel__escribe", g)
    for (let i = 0; i <= turnos; i++) {
      const msgs = $$<HTMLElement>(`[data-turno="${i}"]`, g)
      const suyos = msgs.filter((m) => m.classList.contains("tel__msg--ella"))
      const respuestas = msgs.filter((m) => !m.classList.contains("tel__msg--ella"))
      tl.from(
        suyos,
        {
          y: 14,
          opacity: 0,
          scale: 0.9,
          transformOrigin: "100% 100%",
          duration: 0.35,
          ease: "back.out(1.8)",
        },
        i === 0 ? 0.2 : ">+0.2",
      )
      tl.set(puntos, { autoAlpha: 1 }, ">").set(puntos, { autoAlpha: 0 }, ">+0.55")
      tl.from(
        respuestas,
        {
          y: 14,
          opacity: 0,
          scale: 0.9,
          transformOrigin: "0% 100%",
          duration: 0.4,
          ease: "back.out(1.8)",
        },
        "<",
      ).from(
        respuestas.flatMap((r) => $$(".tel__nota", r)),
        { opacity: 0, x: -8, duration: 0.3 },
        ">-0.1",
      )
    }
    tl.from(
      $$(".despues", g),
      { y: 24, opacity: 0, duration: 0.45, stagger: 0.1, ease: "expo.out" },
      ">+0.15",
    )
    for (const lado of celular ? [g] : $$("[data-tel-lado]", g))
      tl.from(
        $$("[data-despues]", lado),
        { x: -12, opacity: 0, duration: 0.25, stagger: 0.12 },
        "<+0.15",
      )
    tl.from(
      $$("[data-tel-fin]", g),
      { scale: 2, opacity: 0, rotate: -12, duration: 0.4, ease: "back.out(2)", stagger: 0.15 },
      ">",
    )
    if (!celular || g.dataset.telLado === "sofi")
      tl.add(() => {
        t.querySelector('[data-tel-lado="otro"]')?.classList.add("es-perdio")
        t.querySelector('[data-tel-lado="sofi"]')?.classList.add("es-gano")
      })
  }
}

/** Cada fila de la tabla llega con sus dos lados cruzándose: el otro desde la izquierda, el ARM desde la derecha. */
function tablas() {
  for (const tabla of $$("[data-comp]")) {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: tabla, start: desde("top 80%") },
    })
    for (const [i, fila] of $$("tbody tr", tabla).entries()) {
      const t = i * 0.12
      tl.from($$("th", fila), { opacity: 0, y: 10, duration: 0.4 }, t)
        .from(
          $$("td:not(.comp__arm)", fila),
          { opacity: 0, x: -30, duration: 0.5, ease: "expo.out" },
          t,
        )
        .from(
          $$("td.comp__arm", fila),
          { opacity: 0, x: 30, duration: 0.5, ease: "expo.out" },
          t + 0.06,
        )
    }
  }
}

/** Las tarjetas que llevan a cada comparación entran giradas y se inclinan hacia el puntero. */
function versus() {
  const tarjetas = $$("[data-inclina]")
  if (!tarjetas.length) return
  gsap.from(tarjetas, {
    y: 80,
    rotateX: 25,
    opacity: 0,
    duration: 1,
    stagger: 0.15,
    ease: "expo.out",
    scrollTrigger: { trigger: tarjetas[0], start: desde("top 85%") },
  })
  if (!window.matchMedia("(hover: hover)").matches) return
  for (const c of tarjetas) {
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width - 0.5
      const y = (e.clientY - r.top) / r.height - 0.5
      gsap.to(c, { rotateY: x * 10, rotateX: -y * 10, duration: 0.4, ease: "power2.out" })
    })
    c.addEventListener("pointerleave", () =>
      gsap.to(c, { rotateX: 0, rotateY: 0, duration: 0.6, ease: "power3.out" }),
    )
  }
}

/**
 * El ciclo completo: en computadora, la fila de los 8 pasos se fija y corre de lado mientras se baja,
 * con su barra de avance; en el celular, los pasos entran de a uno.
 */
function ciclo() {
  const c = document.querySelector<HTMLElement>("[data-ciclo]")
  const pista = c?.querySelector<HTMLElement>("[data-ciclo-pista]")
  if (!c || !pista) return
  const pasos = $$("[data-paso]", pista)
  if (!window.matchMedia("(min-width: 1024px)").matches) {
    for (const p of pasos)
      gsap.from(p, {
        y: 50,
        opacity: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: p, start: desde("top 90%") },
      })
    return
  }
  c.classList.add("ciclo--corre")
  const distancia = () => pista.scrollWidth - window.innerWidth + 80
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: c,
      start: "top top",
      end: () => `+=${distancia()}`,
      pin: true,
      scrub: 0.8,
      invalidateOnRefresh: true,
    },
  })
  tl.to(pista, { x: () => -distancia(), ease: "none" }, 0).fromTo(
    "[data-ciclo-barra]",
    { scaleX: 0 },
    { scaleX: 1, ease: "none" },
    0,
  )
  gsap.from(pasos, {
    y: 60,
    opacity: 0,
    rotate: 3,
    duration: 0.9,
    stagger: 0.07,
    ease: "expo.out",
    scrollTrigger: { trigger: c, start: "top 70%" },
  })
}

/** Las barras de cobertura se llenan al llegar; la de gestorIA, al último y hasta el final. */
function cobertura() {
  const l = document.querySelector("[data-cobertura]")
  if (!l) return
  const tl = gsap.timeline({ scrollTrigger: { trigger: l, start: desde("top 75%") } })
  for (const b of $$("[data-barra]", l))
    tl.from(b, { width: 0, duration: 1.1, ease: "power3.out" }, ">-0.6")
  tl.from($$(".barra__cifra", l), { opacity: 0, y: 8, duration: 0.4, stagger: 0.1 }, "<")
}

/** Las tres páginas del ARM: cada una arma lo que tenga. */
export function iniciarArm() {
  if (reduceMovimiento()) return
  titulos()
  ciclo()
  cobertura()
  golpe()
  boleta()
  letras()
  duelo()
  telefonos()
  tablas()
  versus()
}

/**
 * Los seis capítulos de Cómo funciona: un riel naranja se llena con el scroll y cada capítulo se
 * enciende al llegar a la mitad de la pantalla (su número pasa de contorno a lleno).
 */
export function iniciarCapitulos() {
  const lista = document.querySelector<HTMLElement>("[data-capitulos]")
  if (!lista || reduceMovimiento()) return
  document.documentElement.classList.add("capitulos-vivos")
  gsap.fromTo(
    "[data-riel] span",
    { scaleY: 0 },
    {
      scaleY: 1,
      ease: "none",
      scrollTrigger: { trigger: lista, start: "top 60%", end: "bottom 60%", scrub: 0.4 },
    },
  )
  for (const c of $$("[data-capitulo]", lista)) {
    ScrollTrigger.create({
      trigger: c,
      start: "top 62%",
      onEnter: () => {
        c.classList.add("es-activo")
        gsap.fromTo(
          $$(".p-capitulo__n", c),
          { scale: 0.6, rotate: -10 },
          { scale: 1, rotate: 0, duration: 0.7, ease: "back.out(2.4)" },
        )
        gsap.from($$("h2, p", c), {
          x: 30,
          opacity: 0,
          duration: 0.6,
          stagger: 0.08,
          ease: "expo.out",
        })
      },
      onLeaveBack: () => c.classList.remove("es-activo"),
    })
  }
}
