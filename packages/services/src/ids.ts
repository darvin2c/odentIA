/**
 * ¿Puede ser el id de algo guardado? Un enlace con un id roto («/agenda/abc»)
 * dice que no existe (404), no un error del servidor. Acepta las formas que
 * PostgreSQL lee como uuid: con o sin guiones, en mayúsculas o entre llaves.
 */
export function looksLikeId(value: string): boolean {
  return /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i.test(value.trim())
}
