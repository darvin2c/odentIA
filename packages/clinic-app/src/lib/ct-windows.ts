import type { CbctVolume, WindowLevel } from "./cbct-volume"

/**
 * Lo que se elige para ver una tomografía: su nombre y su ventana (ADR 0154).
 * La CBCT dental usa los brillos de cada estudio (ADR 0056), porque sus grises
 * no tienen una escala común entre equipos. La tomografía médica sí la tiene,
 * las unidades Hounsfield, y se mira con las ventanas de uso común en
 * radiología (nivel y ancho en HU; Radiopaedia, «Windowing (CT)»).
 */
export interface ViewWindow {
  key: string
  label: string
  window: WindowLevel
}

/**
 * Las ventanas en HU. Mediastino (50/350) y abdomen (50/400) son casi la misma
 * y van juntas en «Partes blandas», la de uso general para tejido blando.
 */
export const CT_WINDOWS: readonly ViewWindow[] = [
  { key: "pulmon", label: "Pulmón", window: { center: -600, width: 1500 } },
  { key: "blandas", label: "Partes blandas", window: { center: 40, width: 400 } },
  { key: "hueso", label: "Hueso", window: { center: 400, width: 1800 } },
  { key: "cerebro", label: "Cerebro", window: { center: 40, width: 80 } },
]

/** Los tres brillos de la CBCT, calculados con los grises del estudio. */
export function cbctWindows(volume: CbctVolume): ViewWindow[] {
  return [
    { key: "hueso", label: "Hueso", window: volume.presets.hueso },
    { key: "diente", label: "Diente", window: volume.presets.diente },
    { key: "blando", label: "Tejido blando", window: volume.presets.blando },
  ]
}

/**
 * Las ventanas de una tomografía médica, la primera es con la que abre: la del
 * archivo, si trae, y las de HU solo si sus valores son HU. Sin ninguna de las
 * dos, una que muestra todo el rango del estudio.
 */
export function ctWindows(volume: CbctVolume): ViewWindow[] {
  const out: ViewWindow[] = []
  if (volume.fileWindow) out.push({ key: "archivo", label: "Del archivo", window: volume.fileWindow })
  if (volume.hounsfield) out.push(...CT_WINDOWS)
  if (!out.length) {
    const { min, max } = volume.range
    out.push({ key: "automatica", label: "Todo el rango", window: { center: (min + max) / 2, width: Math.max(1, max - min) } })
  }
  return out
}
