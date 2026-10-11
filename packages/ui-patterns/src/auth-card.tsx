import type { ReactNode } from "react"
import { Brand } from "./brand.js"

/** Layout centrado de pantallas de autenticación. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-muted p-4">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-md bg-card p-6">
        <Brand />
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-base font-medium">{title}</h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        <div className="flex flex-col gap-4">
          {children}
          {footer ? (
            <div className="text-center text-sm text-muted-foreground">{footer}</div>
          ) : null}
        </div>
      </div>
    </main>
  )
}
