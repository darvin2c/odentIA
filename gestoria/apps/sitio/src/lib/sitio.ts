// Las direcciones de la web de gestorIA, la llamada a la acción y el mapa de sus páginas (lienzo B8;
// web v3: el plan de páginas de la v2, entregado por partes).

/** El dominio de gestorIA: la web en la raíz y la app en `app.` (ADR 0203). */
export const DOMAIN = "gestoria24.com"
export const SITE_URL = `https://${DOMAIN}`
export const APP_URL = `https://app.${DOMAIN}`
export const LOGIN_URL = `${APP_URL}/login`
export const REGISTER_URL = `${APP_URL}/register`
export const CONTACT_EMAIL = `hola@${DOMAIN}`

/**
 * ¿Ya se puede abrir una tienda y vender en sus chats? Mientras WhatsApp, Instagram y Messenger de
 * gestorIA esperan su conexión con Meta, no: quien crea una tienda arma el catálogo y prueba a Sofi,
 * pero no vende en sus chats. Por eso el botón principal es hablar con nosotros. Abrir el registro lo
 * decide el usuario: ese día esta línea pasa a `true` y el botón principal es «Crea tu tienda».
 */
export const TIENDAS_ABIERTAS = false

/** El mensaje ya escrito del WhatsApp de ventas: por él la administración sabe que es gestorIA. */
export const SALES_TEXT = "Hola, quiero información de gestorIA"

/**
 * El WhatsApp de ventas del Grupo Sallca, el mismo de las webs de las clínicas (`VITE_SALES_WHATSAPP`,
 * E.164), con el mensaje ya escrito. Sin un número válido, `null`: la web no muestra el botón.
 */
export function salesWhatsAppHref(phone: string | undefined): string | null {
  const digits = (phone ?? "").trim()
  if (!/^\+[1-9][0-9]{6,14}$/.test(digits)) return null
  return `https://wa.me/${digits.slice(1)}?text=${encodeURIComponent(SALES_TEXT)}`
}

/** `short` es el mismo botón en la cabecera, donde cabe menos. */
export type Cta = { href: string; label: string; short: string }

/**
 * El botón principal de la web. Con las tiendas abiertas, «Crea tu tienda»; si no, el WhatsApp de
 * ventas y, sin número, la página de contacto (que tiene el correo).
 */
export function primaryCta(open: boolean, whatsapp: string | null): Cta {
  if (open) return { href: REGISTER_URL, label: "Crea tu tienda", short: "Crea tu tienda" }
  if (whatsapp) return { href: whatsapp, label: "Escríbenos por WhatsApp", short: "Escríbenos" }
  return { href: "/contacto", label: "Escríbenos", short: "Escríbenos" }
}

export const salesWhatsApp = salesWhatsAppHref(import.meta.env.VITE_SALES_WHATSAPP)
export const cta = primaryCta(TIENDAS_ABIERTAS, salesWhatsApp)

export type NavLink = { href: string; label: string }

/**
 * Una página del plan de la web (las 25 de la v2). `path` es su dirección cuando exista; `lista`
 * dice si ya se armó. Mientras no, el enlace lleva a su parte del Inicio (`hoy`), o no se muestra:
 * la web nunca enlaza a una página que no existe (lo comprueba `scripts/comprobar-armado.mjs`).
 */
export type Pagina = {
  label: string
  /** Lo que hace, en pocas palabras: el menú de la cabecera lo muestra debajo del nombre. */
  hint?: string
  path: string
  lista: boolean
  hoy?: string
}

/** El enlace de una página hoy: su dirección si existe, su parte del Inicio, o nada. */
export function hrefOf(p: Pagina): string | null {
  if (p.lista) return p.path
  return p.hoy ?? null
}

/** Las páginas de un grupo que hoy tienen adónde llevar, como enlaces. */
export function linksOf(pages: Pagina[]): NavLink[] {
  return pages.flatMap((p) => {
    const href = hrefOf(p)
    return href ? [{ href, label: p.label }] : []
  })
}

/** El mapa de la web, por grupos, en el orden del pie. */
export const SITE_MAP = {
  producto: [
    {
      label: "Sofi",
      hint: "Atiende, negocia y cobra",
      path: "/sofi",
      lista: false,
      hoy: "/#venta",
    },
    {
      label: "Cobros",
      hint: "El pago de cada pedido",
      path: "/cobros",
      lista: false,
      hoy: "/#pedidos",
    },
    {
      label: "Entregas",
      hint: "Solo con el pago confirmado",
      path: "/entregas",
      lista: false,
      hoy: "/#entrega",
    },
    {
      label: "Clientes",
      hint: "La ficha de cada clienta",
      path: "/clientes",
      lista: false,
      hoy: "/#clientas",
    },
    { label: "Catálogo", hint: "Tu vitrina con tu marca", path: "/catalogo", lista: false },
    { label: "Inventario", hint: "Stock por variante", path: "/inventario", lista: false },
    { label: "Argos", hint: "Lo que te toca hoy", path: "/argos", lista: false },
  ],
  recursos: [
    { label: "Rubros", path: "/rubros", lista: false, hoy: "/#rubros" },
    { label: "Preguntas", path: "/preguntas", lista: false, hoy: "/#preguntas" },
    { label: "Cómo funciona", path: "/como-funciona", lista: false },
    { label: "Guías", path: "/guias", lista: false },
    { label: "Integraciones", path: "/integraciones", lista: false },
    { label: "Comparar", path: "/comparar", lista: false },
  ],
  empresa: [
    { label: "Precios", path: "/precios", lista: false, hoy: "/#precio" },
    { label: "Contacto", path: "/contacto", lista: true },
    { label: "Repartidores", path: "/repartidores", lista: false },
  ],
  legal: [
    { label: "Términos", path: "/terminos", lista: true },
    { label: "Privacidad", path: "/privacidad", lista: true },
  ],
} satisfies Record<string, Pagina[]>

/** Las palabras de la cabecera; «Producto» abre su menú con las páginas del producto. */
export const mainNav: NavLink[] = [
  { href: "/#venta", label: "Producto" },
  ...linksOf([SITE_MAP.recursos[0], SITE_MAP.empresa[0], SITE_MAP.recursos[1]]),
]

/** El pie de todas las páginas: los grupos del mapa que hoy tienen enlaces. */
export const footerGroups: { title: string; links: NavLink[] }[] = [
  { title: "Producto", links: linksOf(SITE_MAP.producto) },
  { title: "Recursos", links: linksOf(SITE_MAP.recursos) },
  { title: "Empresa", links: linksOf(SITE_MAP.empresa) },
  {
    title: "Tu tienda",
    links: [
      { href: LOGIN_URL, label: "Entrar" },
      ...(TIENDAS_ABIERTAS ? [{ href: REGISTER_URL, label: "Crea tu tienda" }] : []),
    ],
  },
].filter((g) => g.links.length > 0)

/** La última línea del pie: Términos y Privacidad, que enlazan los correos de la cuenta. */
export const footerLinks: NavLink[] = linksOf(SITE_MAP.legal)

export const SIGNATURE = "gestorIA es una marca del Grupo Sallca"
