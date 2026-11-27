import "./estilos.css"
import { BrandProvider, Toaster } from "@odentia/ui"
import { applyTheme, readStoredTheme } from "@odentia/ui-patterns"
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"

// El tema de la persona (claro, oscuro o el del equipo), como en la app. Publicado, manda el tema
// que pone la página que lo muestra (`data-theme` en la raíz), si lo pone.
const root = document.documentElement
root.dataset.brand = "gestoria"
const tema = () => {
  const host = root.dataset.theme
  applyTheme(host === "dark" || host === "light" ? host : readStoredTheme())
}
tema()
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", tema)
new MutationObserver(tema).observe(root, { attributes: true, attributeFilter: ["data-theme"] })

// Los filtros de las listas (`FilterBar`) guardan lo elegido en la búsqueda del router: aquí vive en
// memoria, porque las pantallas del prototipo van tras «#» (se publica como archivos sueltos).
const rootRoute = createRootRoute({ component: App })
const router = createRouter({
  routeTree: rootRoute,
  history: createMemoryHistory({ initialEntries: ["/"] }),
})

const container = document.getElementById("app")
if (container)
  createRoot(container).render(
    <StrictMode>
      <BrandProvider brand="gestoria">
        <RouterProvider router={router} />
        <Toaster position="top-center" richColors />
      </BrandProvider>
    </StrictMode>,
  )
