/**
 * Normalización de texto para buscar entre opciones: sin diacríticos, en
 * minúsculas y en la locale del producto, para que `peru` encuentre `Perú` y
 * `bogota` encuentre `Bogotá`.
 *
 * Vive aquí y no dentro de un componente porque ya lo usan el filtro de listas
 * (`FilterBar`) y el selector de zona horaria; una segunda copia sería una
 * segunda convención.
 */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es-PE")
}
