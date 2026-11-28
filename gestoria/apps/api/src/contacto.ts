import { z } from "zod"

/**
 * Cómo se escribe a quien se suma a la tienda (lienzo «gestorIA · Configuración, de nuevo», tablero
 * 9): su nombre y su celular, iguales para la invitación al equipo y para el repartidor.
 */

/** E.164: «+» y de 7 a 15 dígitos, el primero no es cero (UIT-T E.164). */
export const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "Escribe su celular con su código de país, como +51 912 345 678")

/** El nombre como lo escribe la tienda, sin espacios de más. */
export const personName = z
  .string()
  .trim()
  .min(1, "Escribe su nombre")
  .max(80, "Máximo 80 caracteres")
  .transform((name) => name.replace(/\s+/g, " "))
