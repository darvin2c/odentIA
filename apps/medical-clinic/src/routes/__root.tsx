import { BrandProvider, Toaster } from "@odentia/ui"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router"
import { type ReactNode, useEffect } from "react"
import favicon from "../../../../assets/brand/latidia/favicon.svg?url"
import appCss from "../styles/app.css?url"

export const Route = createRootRoute({
  head: () => ({
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

const queryClient = new QueryClient()

function RootComponent() {
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
