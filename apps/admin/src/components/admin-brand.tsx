/**
 * La marca de la administración (ADR 0091): la «A» grafito con
 * «Administración» y los logos de los dos productos que se manejan desde aquí,
 * cada uno con su color, el único color de la cabecera.
 */
import { Brand } from "@odentia/ui-patterns"
import type { CSSProperties } from "react"

/** La «A» grafito de la administración, la misma de la pestaña. */
export function AdminMark() {
  return (
    <span
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-primary text-base font-extrabold text-primary-foreground"
    >
      A
    </span>
  )
}

/** «A» + «Administración». */
export function AdminBrand() {
  return (
    <span className="flex items-center gap-2.5">
      <AdminMark />
      <span className="font-heading text-lg font-extrabold tracking-tight">Administración</span>
    </span>
  )
}

/** Los logos de odentIA y latidIA, en una línea. */
export function ProductLogos({ className = "" }: { className?: string }) {
  return (
    // Cada logo ya se nombra solo (`role="img"`).
    <div className={`flex items-center gap-4 ${className}`}>
      <span style={{ "--identity-accent": "var(--product-dental)" } as CSSProperties}>
        <Brand brand="odentia" className="w-24" />
      </span>
      <span style={{ "--identity-accent": "var(--product-medical)" } as CSSProperties}>
        <Brand brand="latidia" className="w-24" />
      </span>
    </div>
  )
}
