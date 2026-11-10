import { BASE_PRODUCT, type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"
import type { ClinicAppearance } from "./clinic-color"

/** Los íconos de cada producto en `public/pwa/` (los genera `scripts/pwa-icons.mjs`). */
const ICON_NAMES: Record<ClinicalProduct, string> = { dental: "odentia", medical: "latidia", optical: "vistia" }

/**
 * El manifiesto de la app instalada (W3C Web App Manifest): se llama como la
 * clínica, con el ícono de su producto y su color, así quien trabaja en dos
 * clínicas distingue los dos íconos. Abre en Inicio y sin la barra del navegador.
 */
export function clinicWebManifest(appearance: ClinicAppearance) {
  const product = isClinicalProduct(appearance.product) ? appearance.product : BASE_PRODUCT
  const brand = productWords(product).name
  const name = appearance.name?.trim() || brand
  const icon = ICON_NAMES[product]
  return {
    id: "/home",
    name,
    // Lo que cabe bajo el ícono del teléfono.
    short_name: name.length > 12 ? brand : name,
    description: `${name} en ${brand}`,
    lang: "es",
    start_url: "/home",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: appearance.brandColor ?? "#ffffff",
    icons: [
      { src: `/pwa/${icon}-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/pwa/${icon}-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/pwa/${icon}-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }
}
