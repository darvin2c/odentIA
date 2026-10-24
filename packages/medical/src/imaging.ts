import type { ImagingType } from "@odentia/clinical"

/**
 * Las imágenes de un consultorio (issue 229): las que se piden en medicina
 * general y llegan del laboratorio o del centro de imágenes, con su informe,
 * y la foto clínica. Van en la categoría documental de siempre: la de las
 * imágenes diagnósticas («radiografia») o la de las fotos.
 */
export const MEDICAL_IMAGING_TYPES: readonly ImagingType[] = [
  { value: "radiografia_simple", label: "Radiografía", category: "radiografia" },
  { value: "ecografia", label: "Ecografía", category: "radiografia" },
  { value: "tomografia_computarizada", label: "Tomografía computarizada", category: "radiografia" },
  { value: "resonancia_magnetica", label: "Resonancia magnética", category: "radiografia" },
  { value: "mamografia", label: "Mamografía", category: "radiografia" },
  { value: "foto_clinica", label: "Foto clínica", category: "foto_clinica" },
]

/** En un consultorio la categoría reúne más que radiografías: se nombra «Imagen diagnóstica». */
export const MEDICAL_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  radiografia: "Imagen diagnóstica",
}
