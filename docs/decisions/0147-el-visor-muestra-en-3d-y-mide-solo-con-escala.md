# 0147. El visor muestra en 3D para explicar y mide en mm solo con una escala que vale

- **Fecha:** 2026-11-06
- **Estado:** aceptada (lienzo «Visor de imágenes: ver, entender y mostrar», decisiones 1 a 8). Revisa la decisión 7 del lienzo del visor de tomografía y precisa el ADR 0056.

## Problema

El ADR 0056 armó la tomografía en la CPU, sin WebGL, y dejó el 3D fuera porque para medir hueso o ver un conducto se usan cortes. Pero el odontólogo también le explica el caso al paciente, y un volumen que se gira se entiende mejor que un corte. Además, el visor 2D medía en mm con el espaciado del detector (Imager Pixel Spacing): en la panorámica y la cefalométrica, que vienen ampliadas, la cifra salía más grande de lo real.

## Decisión y motivo

- **El 3D es solo para mostrar.** Tiene su pestaña, para verlo grande y mostrárselo al paciente, y es además el cuarto cuadro de «Cortes», con «Ver grande»; en el celular es una vista más. Se gira arrastrando, «Ver por dentro» lo abre desde adelante y lleva el aviso «el hueso fino puede no verse». No mide ni se guarda en la atención: el umbral del 3D puede borrar la tabla ósea fina y llevar a decir «ahí no hay hueso». Lo que vale sigue en los cortes.
- **Lo dibuja NiiVue** (BSD-2) con WebGL2, sobre una copia del volumen reducida a 256 vóxeles por lado como máximo, armada en memoria como NIfTI. Se descarga solo al abrir el 3D y queda fuera del paquete del servidor (`clinicAppWorkerStubs`). Sin WebGL2 se dice y los cortes siguen igual. Los cortes, la panorámica y las medidas siguen en la CPU, como decidió el ADR 0056.
- **Medir en mm solo con una escala que vale** (PS3.3 C.8.11.1.1 y C.8.11.7, `measureSpacing`): Pixel Spacing ya está en el plano del paciente; Imager Pixel Spacing se corrige con la ampliación del archivo (0018,1114) y, sin ella, solo vale en la intraoral, donde el sensor va pegado al diente. La panorámica (modalidad PX) nunca se mide en mm: su ampliación cambia de un punto a otro. Donde no se puede, se dice al intentar medir, con la salida (la periapical o la tomografía).
- **DICOM completo**: también Deflate y HTJ2K (OpenJPH, de la misma familia de códecs que ya se usaba), y la radiografía DICOM de hasta 30 MB por la subida de siempre. Los formatos que no son DICOM (TIFF, BMP, HEIC, STL, PLY, OBJ) se rechazan diciendo qué exportar.

## Alternativas descartadas

- **Cornerstone3D u OHIF.** Siguen descartados por lo que dice el ADR 0056: OHIF es otra aplicación, con su pantalla y sus permisos, y ninguno trae la panorámica dental.
- **Escribir el 3D a mano.** Una versión básica es corta, pero la calidad está en el recorte, la iluminación, el celular y las tarjetas gráficas raras: ahí una librería probada ahorra errores.
- **Medir la panorámica con un aviso de «orientativa».** Una cifra que se sabe errada no se muestra como medida, aunque lleve aviso.
- **Guardar medidas de la radiografía 2D.** La tabla `imaging_measurement` es de la tomografía; abrirla a la radiografía pide migración y primero había que medir bien. Queda pendiente.

## Consecuencias

- El 3D depende de la tarjeta gráfica y usa otra copia del volumen en ella; el resto del visor sigue sin depender de la GPU.
- El tope de memoria del volumen supone poca memoria en un celular o una tablet cuando el navegador no la dice (Safari y Firefox), para que salga el aviso en vez de cerrarse la pestaña.
- latidIA todavía no guardaba la tomografía: al reconocerla en una carpeta o un ZIP se decía antes de subir. Desde el ADR 0152 la guarda y la ve en cortes.

## Referencias

- `packages/clinic-app/src/components/patient/tomography-3d.tsx`, `lib/cbct-nifti.ts`, `lib/dicom.ts` (`measureSpacing`), `lib/use-zoom-pan.ts`, `components/patient/viewer-shell.tsx`, `image-viewer-2d.tsx`.
- ADR 0055, 0056 y 0138.
