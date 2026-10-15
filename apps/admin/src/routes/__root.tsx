import { Toaster } from "@odentia/ui"
import { ErrorState, PageShell } from "@odentia/ui-patterns"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router"
import { type ReactNode, useEffect, useState } from "react"
import faviconIco from "../../../../assets/brand/favicon.ico?url"
import favicon from "../../../../assets/brand/favicon.svg?url"
import { panelUrl } from "../lib/host"
import appCss from "../styles/app.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "robots", content: "noindex, nofollow" },
      { title: "Administración · odentIA" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: faviconIco, sizes: "16x16 32x32 48x48 64x64" },
      { rel: "icon", href: favicon, type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
  errorComponent: ({ error, reset }) => (
    <PageShell maxWidth="md">
      <ErrorState
        error={error instanceof Error ? error : "No se pudo abrir esta página"}
        onRetry={reset}
      />
      <a className="mt-4 inline-block underline" href={panelUrl()}>
        Volver a mi cuenta
      </a>
    </PageShell>
  ),
  notFoundComponent: () => (
    <PageShell maxWidth="md">
      <ErrorState
        title="Página no encontrada"
        message="Esta dirección no pertenece a la administración."
      />
      <a className="mt-4 inline-block underline" href="/">
        Ir al inicio
      </a>
    </PageShell>
  ),
})

function RootComponent() {
  // Cada render SSR tiene su propia caché: nunca compartir datos entre sesiones.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }),
  )
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

function RootDocument({ children }: { children: ReactNode }) {
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
