import { Zip, ZipPassThrough } from "fflate"

/** ZIP sin compresión que se arma mientras se envía: un archivo tras otro. */
export async function* zipStream(
  entries: readonly { name: string; open: () => Promise<ReadableStream<Uint8Array>> }[],
  mtime: Date,
): AsyncGenerator<Uint8Array> {
  const chunks: Uint8Array[] = []
  let failure: Error | null = null
  const zip = new Zip((error, chunk) => {
    if (error) failure = error
    else chunks.push(chunk)
  })
  const drain = function* () {
    if (failure) throw failure
    while (chunks.length) yield chunks.shift()!
  }
  for (const entry of entries) {
    const file = new ZipPassThrough(entry.name)
    file.mtime = mtime
    zip.add(file)
    const reader = (await entry.open()).getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      file.push(value)
      yield* drain()
    }
    file.push(new Uint8Array(0), true)
    yield* drain()
  }
  zip.end()
  yield* drain()
}
