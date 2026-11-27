import "./estilos.css"
import { BrandProvider, Toaster } from "@odentia/ui"
import { applyTheme, readStoredTheme } from "@odentia/ui-patterns"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app"

// El tema de la persona (claro, oscuro o el del equipo), como en la app. Publicado, manda el tema
// que pone la página que lo muestra (`data-theme` en la raíz), si lo pone.
const root = document.documentElement
// La marca va en la raíz (colores y logo de gestorIA), también si la página publicada la envuelve.
root.dataset.brand = "gestoria"
const tema = () => {
  const host = root.dataset.theme
  applyTheme(host === "dark" || host === "light" ? host : readStoredTheme())
}
tema()
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", tema)
new MutationObserver(tema).observe(root, { attributes: true, attributeFilter: ["data-theme"] })

const container = document.getElementById("app")
if (container)
  createRoot(container).render(
    <StrictMode>
      <BrandProvider brand="gestoria">
        <App />
        <Toaster position="top-center" richColors />
      </BrandProvider>
    </StrictMode>,
  )
