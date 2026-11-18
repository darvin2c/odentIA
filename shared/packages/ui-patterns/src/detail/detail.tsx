import { useDetailMode } from "../master-detail.js"
import { DetailDrawer, type DetailDrawerProps } from "./detail-drawer.js"
import { DetailPanel } from "./detail-panel.js"

export type DetailProps = DetailDrawerProps

/**
 * Detalle que elige su contenedor según el ancho: tarjeta lateral en pantalla
 * ancha (`useDetailMode` → corte de 1280px) y drawer modal por debajo. Es la
 * pieza para colocar un detalle sin que la página repita la bifurcación de
 * modo; el ancho del panel lo aporta el contenedor donde viva (la columna de
 * `MasterDetail`), y `size` solo aplica al drawer.
 *
 * Dentro de `MasterDetail` conviene usar los dos contenedores explícitos: el
 * panel se anima colapsando su columna y esa columna se controla pasando `null`
 * como `panel`, así que la página necesita decidir el modo para pasar el nodo
 * (ver la story «Detalle/En lista»). `Detail` es para el resto de las
 * colocaciones: una columna propia, un aside, o una pantalla sin lista.
 */
export function Detail({ open, ...props }: DetailProps) {
  const mode = useDetailMode()

  if (mode === "panel") {
    return open ? <DetailPanel {...props} /> : null
  }

  return <DetailDrawer open={open} {...props} />
}