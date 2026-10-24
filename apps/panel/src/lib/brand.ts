import { type ClinicalProduct, isClinicalProduct, productWords } from "@odentia/clinical"

/**
 * El producto de este panel (decisión 9 del issue 229): cada dominio tiene su
 * build, con `VITE_PRODUCT` (`dental` en el de odentIA, `medical` en el de
 * latidIA). Sin decirlo, odentIA. De él salen el nombre, el logo, el color y
 * las palabras del acceso.
 */
export const PANEL_PRODUCT: ClinicalProduct = isClinicalProduct(import.meta.env.VITE_PRODUCT)
  ? import.meta.env.VITE_PRODUCT
  : "dental"

export const panelWords = productWords(PANEL_PRODUCT)
