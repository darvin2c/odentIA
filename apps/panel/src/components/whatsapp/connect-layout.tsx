import { clinicColorCss } from "@odentia/clinical"
import { Brand } from "@odentia/ui-patterns"
import type { ReactNode } from "react"
import { AuthLegal } from "../../lib/auth-screens"

/**
 * Una pantalla de trabajo, no la de entrada: quien llega ya está dentro de su
 * clínica y solo conecta WhatsApp. Sigue en el panel porque Meta solo abre su
 * ventana desde un dominio registrado; lleva el nombre y el color de la clínica
 * (ADR 0162) y la vuelta a ella.
 */
export function ConnectLayout({
  title,
  intro,
  clinicName,
  back,
  brandColor,
  children,
}: {
  title: string
  intro?: ReactNode
  clinicName: string | null
  back: ReactNode
  brandColor: string | null
  children: ReactNode
}) {
  const css = clinicColorCss(brandColor)
  return (
    <div className="flex min-h-svh flex-col bg-muted">
      {css ? <style>{css}</style> : null}
      <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-8">
        <Brand className="w-28 shrink-0 sm:w-32" />
        {back}
      </header>
      <main className="flex flex-1 justify-center px-4 py-8 sm:px-8 sm:py-10">
        <div className="flex w-full max-w-2xl flex-col gap-4">
          {clinicName ? (
            <p className="text-sm break-words text-muted-foreground">{clinicName} · Integraciones · WhatsApp</p>
          ) : null}
          <h1 className="text-2xl font-bold text-balance break-words">{title}</h1>
          {intro ? <p className="text-sm text-muted-foreground">{intro}</p> : null}
          <section className="elevated flex flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5">{children}</section>
        </div>
      </main>
      <footer className="flex justify-center gap-4 px-4 py-4 text-xs text-muted-foreground">
        <AuthLegal />
      </footer>
    </div>
  )
}

