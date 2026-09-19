/**
 * Dominio de detalle de lectura: shell compartido (`DetailSurface`), contenedores
 * (`DetailPanel` lateral y `DetailDrawer` modal), el selector automático por
 * ancho (`Detail`) y las primitivas de contenido (`DetailSection`,
 * `DetailList`, `DetailField`).
 *
 * El barrel raíz reexporta esta carpeta completa; `detail-surface` es interno
 * (lo consumen los dos contenedores, no las páginas).
 */
export { Detail, type DetailProps } from "./detail.js"
export { DetailDrawer, type DetailDrawerProps } from "./detail-drawer.js"
export {
  type DetailContainerProps,
  DetailPanel,
  type DetailPanelProps,
} from "./detail-panel.js"
export {
  DetailField,
  type DetailFieldProps,
  DetailList,
  type DetailListProps,
  DetailSection,
  type DetailSectionProps,
} from "./detail-rows.js"