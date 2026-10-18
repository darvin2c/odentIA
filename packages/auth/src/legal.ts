/**
 * Versiones vigentes de los documentos (lienzo «Términos con Google», aprobado
 * el 2026-10-17). Única fuente: la web (`LEGAL_UPDATED_ISO` de
 * `apps/web/src/lib/legal/types.ts`), el panel y la plataforma leen de aquí.
 *
 * - `terms`: Términos del servicio y Aviso de privacidad. Los acepta cada
 *   persona.
 * - `agreement`: Contrato de encargo de tratamiento. Lo acepta la clínica, por
 *   quien la abre o la administra; quien entra invitado no.
 *
 * La versión cambia solo cuando cambia algo que importa (una corrección de
 * redacción no): entonces cada uno vuelve a aceptar al entrar. `changes` dice en
 * dos o tres líneas qué cambió; `effectiveAt` es desde cuándo rige y se avisa
 * por correo un mes antes.
 */
export const LEGAL = {
  terms: { version: "2026-10-17", effectiveAt: "2026-10-17", changes: [] as string[] },
  agreement: { version: "2026-10-17", effectiveAt: "2026-10-17", changes: [] as string[] },
} as const

export const LEGAL_VERSION = LEGAL.terms.version
export const AGREEMENT_VERSION = LEGAL.agreement.version
