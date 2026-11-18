import type { ReactNode } from "react"

/**
 * La marca de gestorIA (aprobada el 17 nov): «gestorIA» en IBM Plex Mono Regular con «IA» en
 * naranja, y el isotipo [24] (gestoria24.com, atiende las 24 horas) con el «2» de vistIA y un
 * «4» del mismo grosor. Vive aquí mientras no pase a `@odentia/ui` (cambio aparte, con los
 * trazos del nombre en lugar del texto).
 */
const TWO =
  "M3.25 81.93 3.28 72.67 34.65 44.57Q38.45 41.18 39.83 38.14Q41.22 35.1 41.22 32.07Q41.22 28.2 39.5 25.12Q37.78 22.03 34.78 20.23Q31.78 18.43 27.92 18.43Q23.9 18.43 20.78 20.32Q17.67 22.2 15.91 25.29Q14.15 28.38 14.22 32H3.48Q3.48 25.02 6.66 19.73Q9.83 14.43 15.38 11.47Q20.93 8.5 28.12 8.5Q34.92 8.5 40.32 11.57Q45.72 14.65 48.83 20.01Q51.95 25.37 51.95 32.2Q51.95 37.13 50.66 40.6Q49.37 44.07 46.76 47.02Q44.15 49.97 40.25 53.4L16.05 75L14.92 72H51.95V81.93Z"
const FOUR =
  "M98.7 10V56.5H109.4V66.45H98.7V81.93H88V66.45H60.7V56.5L87.2 10ZM88 29.41L72.56 56.5H88Z"
const BRACKETS = "M16 10H6V102H16M112 10H122V102H112"

function Isotype() {
  return (
    <g>
      <g transform="translate(20 12) scale(.8)">
        <path d={TWO} />
        <path d={FOUR} />
      </g>
      <path d={BRACKETS} fill="none" stroke="currentColor" strokeWidth="5" />
    </g>
  )
}

/** El logotipo; `compact` deja solo el isotipo. */
export function Logo({
  compact = false,
  className = "",
}: {
  compact?: boolean
  className?: string
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={compact ? "0 0 128 112" : "-2 -10 659.13 134"}
      role="img"
      aria-label="gestorIA"
      className={
        (compact ? "block h-8 w-9 shrink-0 " : "block h-auto w-40 max-w-full shrink-0 ") + className
      }
      style={{ color: "var(--identity-accent)" }}
      fill="currentColor"
    >
      {compact ? (
        <Isotype />
      ) : (
        <>
          <text
            x="0"
            y="82"
            fill="var(--identity-ink)"
            style={{
              fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
              fontSize: "103.2px",
              fontWeight: 400,
            }}
          >
            gestor<tspan fill="currentColor">IA</tspan>
          </text>
          <g transform="translate(497.13 -13) scale(1.22)">
            <Isotype />
          </g>
        </>
      )}
    </svg>
  )
}

/** La firma del grupo, en el pie de la entrada (y después, de la web y los correos). */
export function GroupSignature({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-muted-foreground ${className}`}>
      gestorIA es una marca del Grupo Sallca
    </p>
  )
}

/**
 * Las pantallas de entrar, crear la cuenta y recuperar el acceso (lienzo B, tablero 9): una
 * tarjeta centrada con la marca arriba y la firma del grupo abajo. En el celular ocupa el ancho.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-surface-muted px-4 py-8">
      <main className="flex w-full max-w-sm flex-col gap-6 rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
        <Logo className="w-44" />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl leading-tight font-extrabold tracking-[-0.02em] text-balance">
            {title}
          </h1>
          {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
        </div>
        <div className="flex flex-col gap-4">{children}</div>
        {footer ? (
          <div className="border-t pt-4 text-center text-sm text-muted-foreground">{footer}</div>
        ) : null}
      </main>
      <GroupSignature />
    </div>
  )
}

/** Un aviso dentro de un formulario de la entrada. */
export function AuthAlert({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <p
      id={id}
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      {children}
    </p>
  )
}
