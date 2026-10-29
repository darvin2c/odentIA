import { Button } from "@odentia/ui"
import { RECOMMENDED_AUTHENTICATORS } from "@odentia/ui-patterns"
import { useRouterState } from "@tanstack/react-router"
import { useState } from "react"
import { authClient } from "../lib/auth-client"
import { panelUrl, tenantUrl } from "../lib/host"
import { productUi } from "../product/product-ui"

/**
 * La clínica pide verificación en dos pasos a su equipo y esta persona aún no
 * la tiene (ADR 0106): en vez de la aplicación, la API responde
 * `TWO_FACTOR_REQUIRED` y esta pantalla lleva a activarla en Mi perfil, con la
 * vuelta a esta misma dirección. Sus otras clínicas no cambian.
 */
export function TwoFactorRequiredPage({ org }: { org: { name: string; slug: string } }) {
  const href = useRouterState({ select: (state) => state.location.href })
  const [leaving, setLeaving] = useState(false)
  const back = tenantUrl(org.slug, href, productUi().product)
  return (
    <main className="flex min-h-svh justify-center bg-background px-4 py-14">
      <div className="flex w-full max-w-md flex-col gap-6">
        <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
          <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-primary-soft font-bold text-primary-soft-foreground">
            {org.name.trim().charAt(0).toUpperCase()}
          </span>
          {org.name}
        </p>
        <div className="flex flex-col gap-2.5">
          <h1 className="font-heading text-2xl font-extrabold tracking-tight text-balance">{org.name} pide verificación en dos pasos</h1>
          <p className="text-[15px] text-muted-foreground">
            Para proteger los datos de sus pacientes, el equipo entra con su contraseña y un código de una app del teléfono. Lo activas una sola vez y tarda un par de minutos.
          </p>
        </div>
        <section aria-labelledby="apps" className="flex flex-col gap-2 rounded-xl bg-muted p-4 text-sm">
          <h2 id="apps" className="font-bold">
            Instala una de estas en tu teléfono
          </h2>
          <ul className="flex list-disc flex-col gap-1 pl-4 font-medium">
            {RECOMMENDED_AUTHENTICATORS.map((app) => (
              <li key={app}>{app}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Gratis, en Android y iPhone, y guardan copia en tu cuenta: si cambias de teléfono no pierdes el acceso. Si ya usas otra app de códigos, también sirve.
          </p>
        </section>
        <Button size="lg" render={<a href={panelUrl(`/profile?edit=two-factor&next=${encodeURIComponent(back)}`)} />}>
          Activarla ahora
        </Button>
        <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
          <span>Tus otras clínicas no cambian: solo esta la pide.</span>
          <a href={panelUrl("/?cambiar=1")} className="font-semibold text-primary">
            Ir a otra de mis clínicas
          </a>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 font-semibold"
            disabled={leaving}
            onClick={() => {
              setLeaving(true)
              void authClient.signOut().finally(() => window.location.assign(panelUrl("/login")))
            }}
          >
            Cerrar sesión
          </Button>
        </div>
      </div>
    </main>
  )
}
