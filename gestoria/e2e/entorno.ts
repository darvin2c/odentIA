/** Lo que comparten el entorno (`servidor.ts`), la configuración y los recorridos de gestorIA. */
export const API_PORT = 4710
export const ACCOUNT_PORT = 4711
export const WEB_PORT = 4712
export const WEB = `http://127.0.0.1:${WEB_PORT}`
export const ACCOUNT = `http://127.0.0.1:${ACCOUNT_PORT}`

/** La tienda que abre la administración para su clienta. */
export const STORE_ID = "4f9a3c2e-8b1d-4e6f-9a7c-2d5b8e1f3a60"

export const PEOPLE = {
  rosa: { id: "e2e-rosa", email: "rosa@calzados.test", name: "Rosa Quispe" },
  ana: { id: "e2e-ana", email: "ana@soporte.test", name: "Ana de Soporte" },
  /** Atiende la tienda con el rol de Ventas. */
  lucia: { id: "e2e-lucia", email: "lucia@calzados.test", name: "Lucía Torres" },
  /** Todavía sin tienda: crea la suya en el recorrido de los primeros pasos. */
  carmen: { id: "e2e-carmen", email: "carmen@tortas.test", name: "Carmen Huanca" },
} as const
export type Who = keyof typeof PEOPLE

/** La contraseña de todas en la cuenta de mentira. */
export const CLAVE = "clave-de-prueba"

/** El código de la app de autenticación que acepta la cuenta de mentira al activar los dos pasos. */
export const CODIGO_TOTP = "246810"
