import type { ImagingType } from "@odentia/clinical"

/**
 * Las imágenes de una óptica: las pruebas que se hacen en la misma óptica, si
 * tiene el equipo, o llegan de un centro, con su informe, y la foto del ojo.
 * Van en la categoría documental de siempre: la de las imágenes diagnósticas
 * («radiografia») o la de las fotos.
 */
export const OPTICAL_IMAGING_TYPES: readonly ImagingType[] = [
  { value: "retinografia", label: "Retinografía (fondo de ojo)", category: "radiografia" },
  { value: "topografia_corneal", label: "Topografía corneal", category: "radiografia" },
  { value: "tomografia_optica", label: "Tomografía de coherencia óptica (OCT)", category: "radiografia" },
  { value: "campo_visual", label: "Campo visual", category: "radiografia" },
  { value: "foto_segmento_anterior", label: "Foto del ojo", category: "foto_clinica" },
]

/** En una óptica la categoría reúne pruebas del ojo, no radiografías: se nombra «Prueba del ojo». */
export const OPTICAL_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  radiografia: "Prueba del ojo",
}
