// El logotipo y el ícono de cada web, en un mapa completo por producto (ADR 0164): sobre la noche
// de las portadas («dark») y sobre claro («light»), como SVG para escribirlo en la página.
import latidiaFavicon from "../../../../assets/brand/latidia/favicon.svg?url"
import vistiaFavicon from "../../../../assets/brand/vistia/favicon.svg?url"
import latidiaDark from "../assets/latidia-logotipo-dark.svg?raw"
import latidiaLight from "../assets/latidia-logotipo-light.svg?raw"
import odentiaDark from "../assets/logotipo-dark.svg?raw"
import odentiaLight from "../assets/logotipo-light.svg?raw"
import vistiaDark from "../assets/vistia-logotipo-dark.svg?raw"
import vistiaLight from "../assets/vistia-logotipo-light.svg?raw"
import { PRODUCT, type WebProduct } from "./product"

const LOGOS: Record<WebProduct, { dark: string; light: string }> = {
  dental: { dark: odentiaDark, light: odentiaLight },
  medical: { dark: latidiaDark, light: latidiaLight },
  optical: { dark: vistiaDark, light: vistiaLight },
}
export const LOGO = LOGOS[PRODUCT]

/** El ícono de la pestaña: odentIA lleva además el .ico de siempre (de `public/`). */
const ICONS: Record<WebProduct, { svg: string; ico?: string }> = {
  dental: { svg: "/favicon.svg", ico: "/favicon.ico" },
  medical: { svg: latidiaFavicon },
  optical: { svg: vistiaFavicon },
}
export const ICON = ICONS[PRODUCT]
