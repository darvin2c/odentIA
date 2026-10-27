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
  terms: {
    version: "2026-10-26",
    effectiveAt: "2026-10-26",
    changes: [
      "Un solo contrato para odentIA y latidIA, con el titular: SALLCA GROUP E.I.R.L.",
      "El cobro es por lo que hace cada agente, pospago, con presupuesto mensual.",
      "Cómo se cancela, qué datos se descargan y qué pasa si un pago se atrasa.",
    ] as string[],
  },
  agreement: {
    version: "2026-10-26",
    effectiveAt: "2026-10-26",
    changes: [
      "La lista de proveedores que tratan los datos, con su país.",
      "Copia y borrado de los datos de un paciente desde su ficha.",
    ] as string[],
  },
} as const

export const LEGAL_VERSION = LEGAL.terms.version
export const AGREEMENT_VERSION = LEGAL.agreement.version
