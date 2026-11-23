/** Lo de antes que se guarda junto al tiempo de enfermedad: «una semana (antes: 3 días)». */
const EARLIER = /\s*\(antes: [^()]*\)$/u

/**
 * Lo dictado se agrega a lo que ya hay en un campo de la nota, nunca lo reemplaza:
 * perder un texto de la historia no se ve al revisar, y dos frases sí se ven y se
 * arreglan antes de firmar. Solo se omite si el campo ya dice exactamente lo mismo;
 * nunca por parecido, porque «la 36» y «la 37» no son lo mismo. La misma regla para
 * el servidor y para el borrador de la pantalla, que puede ir por delante de él.
 *
 * El tiempo de enfermedad es un solo valor (mesa del 20 nov 2026): «dos meses; como
 * tres meses» no decía cuál vale. Queda lo último dictado y lo que había, entre
 * paréntesis, para que se vea y se arregle antes de firmar. Dice «antes», no «antes
 * dijo»: lo de antes pudo escribirlo el profesional.
 */
export function appendDictated(existing: string | null | undefined, dictated: string, field: string): string {
  const before = (existing ?? "").trim()
  const added = dictated.trim()
  if (!before || !added || before === added) return added || before
  if (field === "illnessDuration") {
    const last = before.replace(EARLIER, "")
    return last === added ? before : `${added} (antes: ${last})`
  }
  return `${before}\n${added}`
}
