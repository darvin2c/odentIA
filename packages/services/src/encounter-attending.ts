import { ServiceError } from "./errors.js"

/**
 * Solo quien lleva la atención escribe en ella (ADR 0002), también desde la
 * ficha: una nota, una receta, el plan o el odontograma unidos a ella. Otro
 * profesional la lee y, para escribir, toma el relevo (queda registrado).
 */
export function assertAttending(row: { professionalUserId: string | null }, actorUserId: string): void {
  if (row.professionalUserId !== actorUserId) {
    throw new ServiceError("NOT_ATTENDING", 409, "Otro profesional lleva esta atención: toma el relevo para continuarla")
  }
}
