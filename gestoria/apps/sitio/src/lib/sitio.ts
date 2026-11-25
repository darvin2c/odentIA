// Las direcciones de la web de gestorIA y la llamada a la acción de toda la web (lienzo B8).

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
 * pero no vende en sus chats. Por eso el botón principal es hablar con nosotros. El día que los
 * chats estén conectados, esta línea pasa a `true` y el botón principal es «Crea tu tienda».
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

/** La cabecera de la portada: sus secciones y el contacto. Sin «Precios» hasta que haya planes. */
export const mainNav: NavLink[] = [
  { href: "/#como", label: "Cómo vende" },
  { href: "/#agentes", label: "Sofi y Argos" },
  { href: "/contacto", label: "Contacto" },
]

/** El pie de todas las páginas: lo que enlazan los correos de la cuenta, y entrar. */
export const footerLinks: NavLink[] = [
  { href: "/terminos", label: "Términos" },
  { href: "/privacidad", label: "Privacidad" },
  { href: "/contacto", label: "Contacto" },
  { href: LOGIN_URL, label: "Entrar" },
]

export const SIGNATURE = "gestorIA es una marca del Grupo Sallca"
