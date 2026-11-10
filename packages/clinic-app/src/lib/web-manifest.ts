import { BASE_PRODUCT, type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import type { ClinicAppearance } from "./clinic-color"

/** `--canvas` de `globals.css`, en claro y en oscuro: las barras del sistema van de ese color. */
export const CANVAS_LIGHT = "#f8f8f8"
export const CANVAS_DARK = "#111111"

/** Los íconos de cada producto en `public/pwa/` (los genera `scripts/pwa-icons.mjs`). */
const ICON_NAMES: Record<ClinicalProduct, string> = { dental: "odentia", medical: "latidia", optical: "vistia" }

/**
 * El manifiesto de la app instalada (W3C Web App Manifest): se llama como la
 * clínica, con el ícono de su producto y su color, así quien trabaja en dos
 * clínicas distingue los dos íconos. Abre en Inicio y sin la barra del navegador.
 */
export function clinicWebManifest(appearance: ClinicAppearance, appProduct?: ClinicalProduct) {
  // El producto de la app manda: una clínica de otro producto se abre en su propio dominio.
  const product = appProduct ?? (isClinicalProduct(appearance.product) ? appearance.product : BASE_PRODUCT)
  const brand = productWords(product).name
  const name = appearance.name?.trim() || brand
  const icon = ICON_NAMES[product]
  return {
    id: "/home",
    name,
    // Bajo el ícono va el nombre de la clínica (el teléfono lo corta si no cabe): así se distinguen dos clínicas.
    short_name: name,
    description: `${name} en ${brand}`,
    lang: "es",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    // El fondo de la app (`--canvas` en claro): las barras del teléfono no quedan blancas.
    // En oscuro lo cambian los `theme-color` de la página (`syncThemeColor`).
    background_color: CANVAS_LIGHT,
    theme_color: CANVAS_LIGHT,
    icons: [
      { src: `/pwa/${icon}-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/pwa/${icon}-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/pwa/${icon}-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
