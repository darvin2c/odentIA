/**
 * Contrato sin código de su teléfono y su WhatsApp. Vive aparte de `people.ts`
 * para que los contratos que solo lo nombran (`agenda.ts`, que también lee e2e)
 * no arrastren el cliente de la API ni `import.meta.env` de Vite.
 */

/** Su teléfono y su WhatsApp (decisión 23), como lo dice el servidor. */
export interface PhoneWhatsApp {
  state: "sin_telefono" | "es_su_whatsapp" | "aun_no" | "no_tiene"
  phone: string | null
  /** La clínica tiene WhatsApp conectado: «Usarlo como su WhatsApp» sirve. */
  canUse: boolean
}
