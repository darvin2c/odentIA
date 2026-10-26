// El motor de las pantallas de muestra de «Todo lo de siempre», común a las dos presentaciones:
// cada pantalla es su dibujo (HTML con las clases `ms-*` de su deck.html) y su guion de pasos.
// deck.js las toma de `window.ModuleScreens` y les pasa su espera, para que se detengan al
// cambiar de parte.
export type Wait = (ms: number) => Promise<void>
export interface ModuleScreen {
  title: string
  sub: string
  body: HTMLElement
  play: (wait: Wait) => Promise<void>
}

export const html = (cls: string, inner: string) => {
  const node = document.createElement("div")
  node.className = cls
  node.innerHTML = inner
  return node
}

/**
 * Un paso de una pantalla: espera, a quién y qué clase le pone («-clase» la quita); con texto,
 * antes le cambia el contenido. Así cada pantalla es su dibujo y su guion, sin código propio.
 */
export type Step = [ms: number, sel: string, cls?: string, text?: string]

export function scripted(title: string, sub: string, cls: string, inner: string, steps: Step[]): () => ModuleScreen {
  return () => {
    const body = html(`ms-scr ${cls}`, inner)
    return {
      title,
      sub,
      body,
      play: async (wait) => {
        for (const [ms, sel, c = "on", text] of steps) {
          await wait(ms)
          const node = body.querySelector<HTMLElement>(sel)
          if (!node) continue
          if (text !== undefined) node.innerHTML = text
          if (!c) continue
          if (c.startsWith("-")) node.classList.remove(c.slice(1))
          else {
            node.classList.remove(c)
            void node.offsetWidth
            node.classList.add(c)
          }
        }
      },
    }
  }
}

export const row = (s: string, t: string, b: string, small: string, pill = "", extra = "") =>
  `<div class="ms-row ms-in ${extra}" data-s="${s}"><span class="t">${t}</span><span class="x"><b>${b}</b><small>${small}</small></span>${pill}</div>`
export const pill = (text: string, tone = "") => `<span class="ms-pill ${tone}">${text}</span>`
export const toast = (text: string, dot = "sky") => `<div class="ms-toast" data-s="toast"><span class="ms-dot ${dot}"></span>${text}</div>`

/** Deja las pantallas de una presentación donde deck.js las busca. */
export function registerScreens(screens: Record<string, () => ModuleScreen>) {
  ;(window as unknown as { ModuleScreens: Record<string, () => ModuleScreen> }).ModuleScreens = screens
}
