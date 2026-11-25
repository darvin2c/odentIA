/**
 * Las plantillas en blanco que la web de un producto ofrece en sus guías (ADR 0215): lo que el
 * aviso adjunta al correo. Cada producto da las suyas en `products.ts` (`guideSheetsFor`); el
 * que no tiene guías, ninguna.
 */
export interface GuideSheets {
  /** Cada plantilla por su clave («odontograma»): el archivo adjunto y su nombre en el correo. */
  readonly sheets: Readonly<Record<string, { readonly file: string; readonly title: string }>>
  /** El PDF de una plantilla, dibujado una sola vez por proceso. */
  bytes(key: string): Promise<Uint8Array>
  /** Lo que el correo cuenta de la app según las plantillas que pidió. */
  pitch(keys: readonly string[]): string
}
