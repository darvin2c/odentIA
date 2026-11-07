/**
 * La barrera de escritura del borrador: drena hasta que no quede nada por
 * guardar. Lo que otra pestaña cambió (en conflicto) no se envía solo, así que
 * si es lo único que queda, la barrera corta con ese aviso en vez de repetir
 * el drenado sin fin (QA del 6 nov: la atención se congelaba al cerrar un
 * bloque, al abrir el cierre o al firmar).
 */
export async function untilWritten<K>({
  drain,
  pending,
  inConflict,
  conflictError,
}: {
  /** Envía lo que se puede enviar; lo en conflicto lo deja como está. */
  drain: () => Promise<void>
  /** Lo que sigue sin guardar después de cada drenado. */
  pending: () => readonly K[]
  inConflict: (key: K) => boolean
  /** El aviso con el que se corta: el de la otra pestaña, si llegó. */
  conflictError: () => unknown
}): Promise<void> {
  for (;;) {
    await drain()
    const left = pending()
    if (left.length === 0) return
    if (left.every(inConflict)) throw conflictError()
  }
}
