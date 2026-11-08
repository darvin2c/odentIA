import { BrandProvider, Toaster } from "@odentia/ui"
import { clinicColorStyles, loadClinicAppearance } from "@odentia/clinic-app/lib/clinic-color"
import { watchNewVersion } from "@odentia/clinic-app/lib/new-version"
import { createQueryClient } from "@odentia/clinic-app/lib/query-client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import favicon from "../../../../assets/brand/latidia/favicon.svg?url"
import appCss from "../styles/app.css?url"

export const Route = createRootRoute({
  // El color de la marca de la clínica (ADR 0162): en el navegador se pide una vez por pestaña
  // (`loadClinicAppearance` lo recuerda) y otra vez al cambiarlo o si falló.
  loader: () => loadClinicAppearance(),
  head: ({ loaderData }) => ({
    styles: clinicColorStyles(loaderData),
    meta: [
      { charSet: "utf-8" },
      // `resizes-content`: al abrir el teclado del celular la página se achica y la caja de texto queda a la vista.
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, interactive-widget=resizes-content",
      },
      { title: "latidIA" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: favicon, type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  // Cada render SSR tiene su propia caché: nunca compartir datos entre sesiones.
  const [queryClient] = useState(createQueryClient)
  // Una versión nueva desplegada con la pestaña abierta: se avisa, no se recarga sola.
  useEffect(() => watchNewVersion(), [])
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true"
    return () => {
      delete document.documentElement.dataset.hydrated
    }
  }, [])
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    </RootDocument>
  )
}

/** latidIA: su logo, su [72] y su color en todas las pantallas (`data-brand`, decisiones 1 y 2 del issue 229). */
function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es" data-brand="latidia">
      <head>
        <HeadContent />
      </head>
      <body>
        <BrandProvider brand="latidia">{children}</BrandProvider>
        <Toaster position="top-center" richColors />
        <Scripts />
      </body>
    </html>
  )
}
