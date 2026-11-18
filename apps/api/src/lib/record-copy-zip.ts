import type { PatientRecordCopy } from "@odentia/services"
import { zipStream } from "./zip-stream.js"

const bytes = (data: Uint8Array) => async () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data)
      controller.close()
    },
  })

/**
 * El ZIP de la copia de la historia, en streaming, con la lista de `buildPatientRecordCopy`. El
 * LÉEME va último: si un archivo no se pudo leer del almacenamiento mientras se armaba, el LÉEME
 * lo nombra (`copy.readme`) y no queda un archivo vacío sin aviso (mesa del 18 nov).
 */
export function recordCopyZip(
  copy: PatientRecordCopy,
  stream: (storageKey: string) => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  const failed: string[] = []
  const last = copy.entries.length - 1
  const entries = copy.entries.map((entry, index) => ({
    name: entry.name,
    open:
      index === last && entry.bytes
        ? async () => bytes(failed.length ? copy.readme(failed) : (entry.bytes as Uint8Array))()
        : entry.bytes
          ? bytes(entry.bytes)
          : () => stream(entry.storageKey ?? ""),
  }))
  return ReadableStream.from(
    zipStream(entries, copy.generatedAt, { onFailure: (name) => failed.push(name) }),
  )
}
