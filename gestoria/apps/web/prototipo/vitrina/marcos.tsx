import { cn } from "@odentia/ui"
import { Lock } from "lucide-react"
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react"
import type { Producto, Rubro } from "../datos"

/** La marca de la tienda («Tu marca»): su color y sus iniciales. */
export function marca(R: Rubro) {
  const mono = R.store.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
  const lema: Record<string, string> = {
    Calzado: "Zapatillas, sandalias y botines para el día a día. Enviamos a todo el Perú.",
    Ropa: "Ropa cómoda para todos los días. Enviamos a todo el Perú.",
    "Cosmética": "Maquillaje y cuidado, con registro sanitario. Enviamos a todo el Perú.",
    "Tecnología": "Audio y accesorios nuevos, con garantía. Enviamos a todo el Perú.",
    Hogar: "Cosas lindas para tu casa. Enviamos a todo el Perú.",
  }
  return {
    mono,
    style: { "--vv-brand": R.store.color } as CSSProperties,
    sub: "Llega mañana en Lima · Pagas al recibir",
    lema: lema[R.label] ?? "Enviamos a todo el Perú.",
    portada: R.gallery[0] ?? "",
  }
}

/** Cuántas personas lo compraron este mes: un número fijo por producto, de ejemplo. */
export function vendidos(p: Producto): number | null {
  if (!/^p\d$/.test(p.id)) return null
  if (p.id === "p1") return 140
  return 9 + ([...p.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 40)
}
export function vendidosTexto(p: Producto) {
  const n = vendidos(p)
  return n == null ? null : n
}

export function Logo({ R, size = 36 }: { R: Rubro; size?: number }) {
  return (
    <span className="logo" style={{ "--s": `${size}px` } as CSSProperties} aria-hidden>
      {marca(R).mono}
    </span>
  )
}

/** Sofi, la figura de la vitrina: se mece despacio; con movimiento reducido, quieta. */
export function SofiFig({ className }: { className?: string }) {
  return (
    <svg className={cn("sofi", className)} viewBox="0 0 64 72" aria-hidden>
      <g className="sofi-fig">
        <path d="M12 40 C5 42 3 48 5 53" fill="none" stroke="var(--vv-brand-deep)" strokeWidth="5" strokeLinecap="round" />
        <path d="M52 40 C59 42 61 48 59 53" fill="none" stroke="var(--vv-brand-deep)" strokeWidth="5" strokeLinecap="round" />
        <rect x="20" y="57" width="9" height="7" rx="3.5" fill="var(--vv-brand-deep)" />
        <rect x="35" y="57" width="9" height="7" rx="3.5" fill="var(--vv-brand-deep)" />
        <rect x="9" y="10" width="46" height="48" rx="15" fill="var(--vv-brand)" />
        <path d="M15 21 C18 15 24 13 32 13 L44 13" fill="none" stroke="#fff" strokeOpacity=".28" strokeWidth="3" strokeLinecap="round" />
        <g transform="translate(14 16) scale(1.5)" fill="none" stroke="var(--vv-on)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </g>
        <circle cx="20" cy="45" r="2.4" fill="#fff" opacity=".22" />
        <circle cx="44" cy="45" r="2.4" fill="#fff" opacity=".22" />
      </g>
      <ellipse cx="32" cy="70" rx="15" ry="2.4" fill="#000" opacity=".18" />
    </svg>
  )
}

export function SofiMini({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <rect x="1" y="1" width="46" height="46" rx="14" fill="var(--vv-brand)" />
      <g transform="translate(6 6) scale(1.5)" fill="none" stroke="var(--vv-on)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 8V4H8" />
        <rect width="16" height="12" x="4" y="8" rx="2" />
        <path d="M15 13v2" />
        <path d="M9 13v2" />
      </g>
    </svg>
  )
}

/** Un celular: la pantalla de 390 px; si no cabe, se achica entero (como se vería). `bare`: llena su caja. */
export function PhoneFrame({ children, height = 780, className, bare }: { children: ReactNode; height?: number; className?: string; bare?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = box.current
    if (!el || bare) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setScale(Math.min(1, r.width / 414, r.height / (height + 24)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [height, bare])
  if (bare)
    return (
      <div className={cn("relative mx-auto h-full w-full max-w-[26rem] overflow-hidden rounded-2xl border bg-background shadow-sm", className)}>{children}</div>
    )
  return (
    <div ref={box} className={cn("flex min-h-0 w-full flex-1 items-start justify-center overflow-hidden", className)}>
      <div style={{ width: 414 * scale, height: (height + 24) * scale }}>
        <div style={{ width: 414, height: height + 24, transform: `scale(${scale})`, transformOrigin: "top left" }} className="rounded-[52px] bg-[#191919] p-3 shadow-[0_40px_90px_-30px_rgb(0_0_0/0.55)]">
          <div className="relative h-full w-full overflow-hidden rounded-[40px]">{children}</div>
        </div>
      </div>
    </div>
  )
}

/** Una ventana de navegador con la dirección: la página se dibuja a 1200 px y se achica para caber. */
export function BrowserFrame({ url, children, width = 1200 }: { url: string; children: ReactNode; width?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.5)
  const [h, setH] = useState(800)
  useEffect(() => {
    const el = box.current
    const page = inner.current
    if (!el || !page) return
    const ro = new ResizeObserver(() => {
      setScale(Math.min(1, el.clientWidth / width))
      setH(page.scrollHeight)
    })
    ro.observe(el)
    ro.observe(page)
    return () => ro.disconnect()
  }, [width])
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-[0_30px_70px_-34px_rgb(0_0_0/0.45)]">
      <div className="flex items-center gap-3 border-b bg-muted/60 px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <i className="size-3 rounded-full bg-[#ff5f57]" />
          <i className="size-3 rounded-full bg-[#febc2e]" />
          <i className="size-3 rounded-full bg-[#28c840]" />
        </span>
        <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate rounded-full bg-background px-3 py-1 text-xs text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          {url}
        </span>
      </div>
      <div ref={box} style={{ height: h * scale }} className="relative overflow-hidden">
        <div ref={inner} style={{ width, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          {children}
        </div>
      </div>
    </div>
  )
}
