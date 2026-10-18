# 0055. El visor de tomografía reconstruye en el navegador

- **Fecha:** 2026-10-18
- **Estado:** aceptada (fases 3 y 4 del lienzo del visor de tomografía, issue 34)

## Problema

La odontóloga necesita ver la tomografía en tres cortes (desde arriba, de frente y de lado) y, sobre todo, en panorámica reconstruida con cortes transversales a lo largo del arco, con brillo, medida y ángulo. Debe funcionar en las computadoras de una clínica mediana y, para ver, en un celular. El lienzo proponía Cornerstone3D. La tensión está entre adoptar un visor general de radiología o construir solo lo que pide una tomografía dental.

## Decisión y motivo

- **Reconstrucción propia en la CPU.** El volumen se carga en memoria como enteros de 16 bits (HU) y cada vista es un remuestreo del volumen: los tres cortes ortogonales, la panorámica y los cortes transversales. La panorámica es un reformateo curvo de grosor fijo a lo largo del arco, y los transversales son planos perpendiculares a él. Con 512³ vóxeles cada vista se calcula en milisegundos, sin WebGL.
- **Lo que Cornerstone sí aporta, se usa.** Sus códecs WebAssembly ya leen las compresiones (fase 1).
- **El arco lo propone el visor**, con un polinomio de segundo grado ajustado al esmalte en la banda oclusal (decisión 2), y se corrige arrastrando cinco puntos. Si no se encuentra, se marca con cinco clics.
- **Los brillos se calculan con cada estudio**: un Otsu de tres clases separa en su histograma el aire, el tejido blando y el tejido duro, y cada brillo sale de esas clases. La CBCT no tiene una escala de grises común entre equipos. Los percentiles sobre todo el cuerpo resultaron frágiles: según el campo de visión, el hueso quedaba negro.
- **Las medidas guardadas** viven en `imaging_measurement` (decisión 3), en coordenadas del paciente en mm, con quién y cuándo. Quitar una medida la retira; no se borra.

## Alternativas descartadas

- **Cornerstone3D.** Pesa varios MB y depende de WebGL y de workers, que ciertas configuraciones de Cross-Origin Isolation complican. Su valor principal es el render 3D, que el lienzo descartó (decisión 7). Tampoco trae la panorámica dental: habría que escribirla igual.
- **OHIF.** Es un visor hospitalario completo y no se integra a la ficha ni a sus permisos.

## Consecuencias

- El visor no depende de la GPU y funciona igual en cualquier navegador moderno. A cambio, la memoria limita: con poca, se ofrecen los cortes uno por uno.
- Si las clínicas piden 3D, este ADR se revisa. Cornerstone3D (o vtk.js directo) podría sumarse sobre el mismo volumen.
- Las medidas son orientativas y así lo dice cada pantalla (decisión 9). El visor no es un dispositivo médico certificado.

## Referencias

- `apps/platform/src/lib/cbct-volume.ts`, `apps/platform/src/lib/cbct-arch.ts`
- `apps/platform/src/components/patient/tomography-viewer.tsx`
- Lienzo «Visor de tomografía», tableros 5 a 8 y decisiones 1 a 3 y 7 a 9; ADR 0054
