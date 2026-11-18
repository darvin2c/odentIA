import { createContext, type ReactNode, useContext } from "react"

/**
 * Las marcas de la plataforma (issue 229): odentIA, el producto dental,
 * latidIA, el médico, y vistIA, el de las ópticas. Comparten el diseño; cambian el nombre, el número del
 * isotipo y el color (`[data-brand]` en `globals.css`). Cada app fija la suya
 * una vez, en su raíz, con `BrandProvider` y `data-brand` en `<html>`.
 */
export const BRANDS = ["odentia", "latidia", "vistia"] as const
export type BrandId = (typeof BRANDS)[number]

export function isBrand(value: unknown): value is BrandId {
  return typeof value === "string" && (BRANDS as readonly string[]).includes(value)
}

/** El nombre de cada marca, como se escribe. */
export const BRAND_NAMES: Record<BrandId, string> = { odentia: "odentIA", latidia: "latidIA", vistia: "vistIA" }

const THREE =
  "M27.17 83.37Q21.8 83.37 17.1 81.33Q12.4 79.3 8.97 75.56Q5.53 71.82 4 66.7L14.1 63.9Q15.53 68.55 19.13 71.02Q22.73 73.48 27.13 73.43Q31.08 73.38 34.1 71.6Q37.12 69.82 38.81 66.72Q40.5 63.63 40.5 59.67Q40.5 53.67 36.77 49.77Q33.05 45.87 27.07 45.87Q25.35 45.87 23.58 46.35Q21.8 46.83 20.23 47.67L15.33 39.4L40.77 16.97L41.87 19.93H6.83V10H50.13V19.97L29.03 40.23L28.93 36.87Q35.77 36.87 40.76 39.88Q45.75 42.9 48.48 48.08Q51.2 53.25 51.2 59.67Q51.2 66.53 47.98 71.88Q44.77 77.23 39.33 80.3Q33.88 83.37 27.17 83.37Z"
const TWO =
  "M60.7 81.93 60.73 72.67 92.1 44.57Q95.9 41.18 97.28 38.14Q98.67 35.1 98.67 32.07Q98.67 28.2 96.95 25.12Q95.23 22.03 92.23 20.23Q89.23 18.43 85.37 18.43Q81.35 18.43 78.23 20.32Q75.12 22.2 73.36 25.29Q71.6 28.38 71.67 32H60.93Q60.93 25.02 64.11 19.73Q67.28 14.43 72.83 11.47Q78.38 8.5 85.57 8.5Q92.37 8.5 97.77 11.57Q103.17 14.65 106.28 20.01Q109.4 25.37 109.4 32.2Q109.4 37.13 108.11 40.6Q106.82 44.07 104.21 47.02Q101.6 49.97 97.7 53.4L73.5 75L72.37 72H109.4V81.93Z"
/** El «7» de latidIA: la barra de arriba del «3» y un trazo del mismo grosor hasta la base del «2». */
const SEVEN = "M6.83 10H50.13V19.97L29.6 81.93H18.27L38.47 19.97H6.83Z"

/** El «2» de vistIA a la izquierda: el mismo «2», centrado donde va el «3». */
const TWO_LEFT =
  "M3.25 81.93 3.28 72.67 34.65 44.57Q38.45 41.18 39.83 38.14Q41.22 35.1 41.22 32.07Q41.22 28.2 39.5 25.12Q37.78 22.03 34.78 20.23Q31.78 18.43 27.92 18.43Q23.9 18.43 20.78 20.32Q17.67 22.2 15.91 25.29Q14.15 28.38 14.22 32H3.48Q3.48 25.02 6.66 19.73Q9.83 14.43 15.38 11.47Q20.93 8.5 28.12 8.5Q34.92 8.5 40.32 11.57Q45.72 14.65 48.83 20.01Q51.95 25.37 51.95 32.2Q51.95 37.13 50.66 40.6Q49.37 44.07 46.76 47.02Q44.15 49.97 40.25 53.4L16.05 75L14.92 72H51.95V81.93Z"
/** El «0» de vistIA: un óvalo con el grosor de trazo del «2», en su lugar de la derecha. */
const ZERO = "M60.7 32A24.35 23.5 0 0 1 109.4 32V59.87A24.35 23.5 0 0 1 60.7 59.87ZM71.4 32V59.87A13.65 13.1 0 0 0 98.7 59.87V32A13.65 13.1 0 0 0 71.4 32Z"

/** Los dos dígitos del isotipo, en su caja de 128 × 112 con los corchetes: el [32], el [72] y el [20] (visión 20/20). */
export const BRAND_DIGITS: Record<BrandId, readonly [string, string]> = {
  odentia: [THREE, TWO],
  latidia: [SEVEN, TWO],
  vistia: [TWO_LEFT, ZERO],
}

const BrandContext = createContext<BrandId>("odentia")

/** La marca de esta app para lo que la dibuja (logo, isotipo, indicador de carga). */
export function BrandProvider({ brand, children }: { brand: BrandId; children: ReactNode }) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>
}

/** La marca de esta app; sin `BrandProvider`, odentIA. */
export function useBrand(): BrandId {
  return useContext(BrandContext)
}
