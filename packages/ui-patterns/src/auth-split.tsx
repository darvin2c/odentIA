import { CalmPulseScene, CalmToothScene, type DayEvent } from "@odentia/brand-scene"
import { type BrandId, useBrand } from "@odentia/ui"
import type { CSSProperties, ReactNode } from "react"
import { Brand } from "./brand.js"

/**
 * La noche de cada marca: el lado de la marca se ve igual en tema claro y
 * oscuro. odentIA, la de la portada de la web; latidIA, en morado (tablero
 * «Marca y color»). El logo y los textos del lado usan los colores en oscuro.
 */
const NIGHT: Record<BrandId, CSSProperties> = {
  odentia: {
    background: "radial-gradient(90% 75% at 50% 0%, #0f3340 0%, #0a2129 50%, #061318 100%)",
    color: "#f1f5f9",
    ["--identity-ink" as string]: "#f1f5f9",
    ["--identity-accent" as string]: "#4fc3d7",
    ["--auth-soft" as string]: "#b9cfd5",
  },
  latidia: {
    background: "radial-gradient(90% 75% at 50% 0%, #26164a 0%, #1b1036 50%, #150c26 100%)",
    color: "#f3effb",
    ["--identity-ink" as string]: "#f3effb",
    ["--identity-accent" as string]: "#b79cf0",
    ["--auth-soft" as string]: "#d6cdea",
  },
}

/** Etiqueta y titular del lado de la marca, con la voz de la web («[ Tu clínica ]», «Omnicanal y agéntica.»). */
export function AuthAside({
  tag,
  title,
  accent,
  children,
}: {
  tag: string
  title: ReactNode
  accent?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <span className="font-mono text-xs uppercase tracking-[0.08em] text-[var(--identity-accent)]">
        [ {tag} ]
      </span>
      <h2 className="max-w-md text-3xl leading-[1.05] font-extrabold tracking-[-0.03em] text-balance text-[var(--identity-ink)] lg:text-[2.6rem]">
        {title}
        {accent ? (
          <>
            <br />
            <span className="text-[var(--identity-accent)]">{accent}</span>
          </>
        ) : null}
      </h2>
      {children ? (
        <div className="flex flex-col gap-3 text-sm text-[var(--auth-soft)] lg:text-base">{children}</div>
      ) : null}
    </div>
  )
}

/**
 * Layout de entrar, crear cuenta y recuperar el acceso (lienzos de acceso,
 * aprobados el 2026-10-17): a la izquierda la marca sobre la noche de la web,
 * con las 32 piezas de su portada (`CalmToothScene`) o, en latidIA, el pulso
 * (`CalmPulseScene`); a la derecha el
 * formulario sobre fondo claro. En el celular la marca es una franja arriba y
 * la tarjeta del formulario sube sobre ella, para que esté a la vista desde la
 * primera pantalla.
 *
 * - `aside`: lo que dice la marca (`AuthAside`); cada pantalla elige el suyo.
 * - `mobileAside`: lo que la franja del celular muestra además del logo; sin
 *   él solo van el logo y las piezas (entrar no vende).
 * - `below`: lo que va bajo el titular en computadora, abajo del lado de la
 *   marca (la acción de un agente en crear cuenta).
 * - `onWork`: avisa cada trabajo nuevo de la escena.
 */
export function AuthSplit({
  title,
  description,
  children,
  footer,
  aside,
  mobileAside,
  below,
  legal,
  onWork,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  aside?: ReactNode
  mobileAside?: ReactNode
  below?: ReactNode
  legal?: ReactNode
  onWork?: (event: DayEvent) => void
}) {
  const brand = useBrand()
  const night = NIGHT[brand]
  return (
    <div className="grid min-h-dvh bg-surface-muted md:grid-cols-2">
      <aside className="relative hidden overflow-hidden md:flex md:flex-col" style={night}>
        <div className="relative z-10 flex flex-col gap-10 p-10 lg:p-12">
          <Brand className="w-44" />
          {aside}
        </div>
        {brand === "latidia" ? (
          <CalmPulseScene className="absolute bottom-14 left-10 h-[30%] w-[calc(100%-5rem)] lg:left-12 lg:w-[calc(100%-6rem)]" />
        ) : (
          <CalmToothScene className="absolute inset-x-0 bottom-0 h-[62%] w-full" onWork={onWork} />
        )}
        {below ? <div className="relative z-10 mt-auto p-10 lg:p-12">{below}</div> : null}
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="relative overflow-hidden md:hidden" style={night}>
          <div className="relative z-10 flex flex-col items-center gap-4 px-5 pt-8 pb-2">
            <Brand className="w-36" />
            {mobileAside ? <div className="w-full">{mobileAside}</div> : null}
          </div>
          {brand === "latidia" ? (
            <CalmPulseScene className="relative block h-32 w-full px-6 pb-12" />
          ) : (
            <CalmToothScene
              className="relative block h-44 w-full"
              onWork={mobileAside ? undefined : onWork}
            />
          )}
        </header>

        <main className="relative z-10 -mt-10 flex flex-1 items-start justify-center px-4 pb-6 md:mt-0 md:items-center md:p-10">
          <div className="flex w-full max-w-sm flex-col gap-5 rounded-2xl bg-card p-6 shadow-lg md:max-w-md md:bg-transparent md:p-0 md:shadow-none lg:max-w-[26rem]">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-2xl leading-tight font-extrabold tracking-[-0.02em] text-balance">
                {title}
              </h1>
              {description ? (
                <div className="text-sm text-muted-foreground">{description}</div>
              ) : null}
            </div>
            <div className="flex flex-col gap-4">
              {children}
              {footer ? (
                <div className="text-center text-sm text-muted-foreground">{footer}</div>
              ) : null}
            </div>
          </div>
        </main>
        {legal ? (
          <footer className="flex justify-center gap-5 px-4 pb-5 text-xs text-muted-foreground">
            {legal}
          </footer>
        ) : null}
      </div>
    </div>
  )
}
