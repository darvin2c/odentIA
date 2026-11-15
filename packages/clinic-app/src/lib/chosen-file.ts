/**
 * El archivo elegido, copiado a la memoria al elegirlo. El navegador no envía un archivo del
 * disco que cambió después de elegirlo (Chrome: `ERR_UPLOAD_FILE_CHANGED`), y eso pasa con una
 * carpeta que se sincroniza con la nube o un programa que lo vuelve a guardar: la subida fallaba
 * siempre, también al reenviarla, y se decía como un corte de conexión (15 nov). Con la copia,
 * lo que se sube es lo que se eligió. Se llama donde el archivo entra a la pantalla, no al
 * enviarlo: entonces ya es tarde. null si ya no se puede leer.
 */
export async function readChosenFile(file: File): Promise<File | null> {
  try {
    return new File([await file.arrayBuffer()], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    })
  } catch {
    return null
  }
}
