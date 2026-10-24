import { createRequire } from "node:module"
import path from "node:path"
import { normalizePath } from "vite"

const require = createRequire(import.meta.url)

/**
 * Lo que necesita Vite para compilar lo común, en cada app y en las pruebas del
 * paquete: el códec JPEG de 12 bits no exporta su `.wasm` (`lib/dicom-codecs.ts`).
 */
export function clinicAppAliases() {
  return [
    {
      find: /^@cornerstonejs\/codec-libjpeg-turbo-12bit\/wasm(\?.*)?$/,
      replacement: `${normalizePath(
        path.join(
          path.dirname(require.resolve("@cornerstonejs/codec-libjpeg-turbo-12bit/wasmjs")),
          "libjpegturbo12wasm.wasm",
        ),
      )}$1`,
    },
  ]
}
