import { BrandProvider, Toaster } from "@odentia/ui"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router"
import { type ReactNode, useEffect } from "react"
import favicon from "../../../../assets/brand/favicon.svg?url"
import faviconIco from "../../../../assets/brand/favicon.ico?url"
import latidiaFavicon from "../../../../assets/brand/latidia/favicon.svg?url"
import { panelWords } from "../lib/brand"
import appCss from "../styles/app.css?url"

/** El ícono de la marca de este panel: odentIA con su .ico para los navegadores viejos; latidIA, el SVG. */
const ICONS =
  panelWords.brand === "latidia"
    ? [{ rel: "icon", href: latidiaFavicon, type: "image/svg+xml" }]
    : [
        { rel: "icon", href: faviconIco, sizes: "16x16 32x32 48x48 64x64" },
        { rel: "icon", href: favicon, type: "image/svg+xml" },
      ]

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: panelWords.name },
    ],
    links: [{ rel: "stylesheet", href: appCss }, ...ICONS],
  }),
  component: RootComponent,
})

const queryClient = new QueryClient()

function RootComponent() {
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
    <html lang="es" data-brand={panelWords.brand}>
      <head>
        <HeadContent />
      </head>
      <body>
        <BrandProvider brand={panelWords.brand}>{children}</BrandProvider>
        <Toaster position="top-center" richColors />
        <Scripts />
      </body>
    </html>
  )
}
