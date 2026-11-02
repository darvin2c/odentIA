/**
 * Lo dictado se agrega a lo que ya hay en un campo de la nota, nunca lo reemplaza:
 * perder un texto de la historia no se ve al revisar, y dos frases sí se ven y se
 * arreglan antes de firmar. Solo se omite si el campo ya dice exactamente lo mismo;
 * nunca por parecido, porque «la 36» y «la 37» no son lo mismo. La misma regla para
 * el servidor y para el borrador de la pantalla, que puede ir por delante de él.
 */
export function appendDictated(existing: string | null | undefined, dictated: string, field: string): string {
  const before = (existing ?? "").trim()
  const added = dictated.trim()
  if (!before || !added || before === added) return added || before
  // El tiempo de enfermedad se escribe en una sola línea.
  return `${before}${field === "illnessDuration" ? "; " : "\n"}${added}`
}
