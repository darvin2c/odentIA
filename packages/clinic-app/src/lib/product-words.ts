import { ORG_ROLES, type OrgRole, roleLabel } from "@odentia/auth/permissions"
import { type ProductWords, productWords } from "@odentia/clinical"
import { productUi } from "../product/product-ui"

/**
 * Las palabras del producto de esta app (entrega 3 del issue 229): quien
 * atiende es «Odontólogo» o «Médico» y lo que se reserva, «unidad dental» o
 * «sala». Las mismas que usa el servidor (`productWords` de `@odentia/clinical`).
 */
export function appWords(): ProductWords {
  return productWords(productUi().product)
}

/** El nombre de un rol en esta app; uno desconocido se muestra tal cual o con `unknown`. */
export function appRoleLabel(role: string, unknown = role): string {
  return (ORG_ROLES as readonly string[]).includes(role)
    ? roleLabel(role as OrgRole, productUi().product)
    : unknown
}

export { upperFirst } from "@odentia/clinical"
