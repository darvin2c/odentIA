/**
 * `dicom-parser` para lo que corre en Node (la semilla, con tsx).
 *
 * El paquete publica solo un UMD minificado, sin `exports` ni módulo ES. Node lo
 * carga como CommonJS y, sin poder ver sus funciones, el espacio de nombres de
 * `import * as` trae solo `default`: `parseDicom` no existe ahí. Vite y Vitest sí
 * reparten las funciones, y por eso el visor del navegador (`clinic-app`) lo
 * importa tal cual. Aquí se toma `default` cuando Node lo deja ahí, y el espacio
 * de nombres cuando un bundler ya lo resolvió. Los tipos no declaran `default`:
 * con `import dicomParser from` no compila.
 */
import * as dicomParserModule from "dicom-parser"

type DicomParser = typeof dicomParserModule

export const dicomParser: DicomParser =
  (dicomParserModule as DicomParser & { default?: DicomParser }).default ?? dicomParserModule
