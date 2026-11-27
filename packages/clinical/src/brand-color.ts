/**
 * El color de la marca de la clínica (ADR 0162): la clínica elige un solo color y de él salen el
 * de la app, el de lo que ve el paciente, el del chat de su web y la línea del membrete.
 */
import { brandColorCss } from "@odentia/ui/lib/brand-color"
import type { ClinicalProduct } from "./products.js"

/**
 * La cuenta del color (paleta, contraste, nombres, los colores de una imagen) es de uso general y
 * vive en `@odentia/ui/lib/brand-color`, que también usa gestorIA. Aquí queda lo de las clínicas:
 * el color de fábrica de cada producto, los sugeridos y las reglas de la clínica.
 */
export * from "@odentia/ui/lib/brand-color"

/** El color de fábrica de cada producto: el primario de odentIA, el de latidIA y el de vistIA en `globals.css`. */
export const PRODUCT_BRAND_COLORS = { dental: "#0e7490", medical: "#6d3fc0", optical: "#147c3b" } as const satisfies Record<ClinicalProduct, string>

/** Cómo se llama el color de fábrica de cada producto entre los sugeridos. */
const FACTORY_COLOR_NAME: Record<ClinicalProduct, string> = { dental: "Turquesa", medical: "Morado", optical: "Verde" }

/**
 * Los sugeridos: los más usados en salud, ordenados por familia. Rojo y ámbar no se
 * sugieren porque son los de error y aviso; se pueden poner igual con el código.
 */
export const SUGGESTED_BRAND_COLORS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: "#0e7490", name: "Turquesa" },
  { hex: "#14b8a6", name: "Aguamarina" },
  { hex: "#38bdf8", name: "Celeste" },
  { hex: "#2563eb", name: "Azul" },
  { hex: "#1e3a8a", name: "Azul marino" },
  { hex: "#15803d", name: "Verde" },
  { hex: "#6ee7b7", name: "Menta" },
  { hex: "#a78bfa", name: "Lila" },
  { hex: "#7c3aed", name: "Morado" },
  { hex: "#db2777", name: "Rosa" },
  { hex: "#ea580c", name: "Naranja" },
  { hex: "#334155", name: "Pizarra" },
]

/**
 * Los sugeridos de un producto, con el de fábrica marcado y primero: si está
 * entre los sugeridos se mueve adelante (el turquesa de odentIA ya lo está; el
 * verde de vistIA pasa adelante) y, si no, va primero en lugar del sugerido de su
 * mismo nombre (en latidIA, su morado en lugar del otro morado).
 */
export function suggestedBrandColors(product: ClinicalProduct): Array<{ hex: string; name: string; factory: boolean }> {
  const factory = PRODUCT_BRAND_COLORS[product]
  const name = FACTORY_COLOR_NAME[product]
  const rest = SUGGESTED_BRAND_COLORS.filter((color) => color.hex !== factory && color.name !== name)
  return [{ hex: factory, name, factory: true }, ...rest.map((color) => ({ ...color, factory: false }))]
}

/** Las reglas del color de la clínica: las mismas de cualquier lugar. Sin color válido, nada. */
export const clinicColorCss = brandColorCss
