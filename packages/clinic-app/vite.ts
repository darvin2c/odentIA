import { createRequire } from "node:module"
import path from "node:path"
import { normalizePath, type Plugin } from "vite"

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

/**
 * En Workers (ADR 0138) los códecs DICOM no se usan al armar la página (se cargan en el navegador,
 * `lib/dicom-codecs.ts`) y ocupaban unos 300 KB del paquete del servidor, que en el plan gratuito
 * no puede pasar de 3 MB: ahí quedan vacíos. Las pruebas de Node no usan este plugin.
 */
export function clinicAppWorkerStubs(): Plugin {
  // También la ruta de pnpm (`@cornerstonejs+codec-…`) a la que lleva el alias del códec de 12 bits.
  // El visor 3D (NiiVue, ADR 0147) también dibuja solo en el navegador, y pdf.js, que dibuja la
  // hoja membretada al subirla (ADR 0182).
  const codec = /@cornerstonejs[\\/+]codec-|@niivue[\\/+]niivue|pdfjs-dist/
  const empty = "\0codec-dicom-vacio"
  return {
    name: "odentia:codecs-dicom-fuera-del-servidor",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "ssr",
    resolveId: (id) => (codec.test(id) ? empty : null),
    load: (id) => (id === empty ? "export default undefined" : null),
  }
}
