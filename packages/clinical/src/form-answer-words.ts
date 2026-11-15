/**
 * La respuesta de una ficha, dicha corta: «Sí», «Clase I», «6 mm», «Rx
 * periapical y Rx panorámica». La misma en el servidor (lo que Clío propuso,
 * la nota de un descarte) y en la pantalla (la propuesta en su pregunta).
 */
export function formAnswerWords(payload: Record<string, unknown>): string {
  const value = payload["value"]
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (typeof value === "number") return `${String(value).replace(".", ",")}${typeof payload["unit"] === "string" && payload["unit"] ? ` ${payload["unit"]}` : ""}`
  if (Array.isArray(value)) return value.join(", ")
  if (typeof value === "string") return value
  return "sin proponer"
}
