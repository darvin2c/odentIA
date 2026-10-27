import { Toaster } from "@odentia/ui"
import { createQueryClient } from "@odentia/clinic-app/lib/query-client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import favicon from "../../../../assets/brand/favicon.svg?url"
import faviconIco from "../../../../assets/brand/favicon.ico?url"
import appCss from "../styles/app.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // `resizes-content`: al abrir el teclado del celular la página se achica y la caja de texto queda a la vista.
      { name: "viewport", content: "width=device-width, initial-scale=1, interactive-widget=resizes-content" },
      { title: "odentIA" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: faviconIco, sizes: "16x16 32x32 48x48 64x64" },
      { rel: "icon", href: favicon, type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  // Cada render SSR tiene su propia caché: nunca compartir datos entre sesiones.
  const [queryClient] = useState(createQueryClient)
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true"
    return () => { delete document.documentElement.dataset.hydrated }
  }, [])
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <Outlet />
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster position="top-center" richColors />
        <Scripts />
      </body>
    </html>
  )
}
