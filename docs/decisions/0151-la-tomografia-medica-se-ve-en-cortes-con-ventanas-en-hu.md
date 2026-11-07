# 0151. La tomografía médica se ve en cortes, con su serie y sus ventanas en HU

- **Fecha:** 2026-11-07
- **Estado:** aceptada (lienzo «La tomografía del paciente, en su ficha», latidIA, decisiones 1 a 7). Amplía los ADR 0055, 0056 y 0147 a latidIA.

## Problema

latidIA no guardaba la tomografía: el visor se hizo para la CBCT dental (panorámica por el arco, «Ir a la pieza», brillos calculados con cada estudio) y su web la prometía. Medimos 60 tomografías médicas públicas de The Cancer Imaging Archive (CC BY). Las recientes traen de 4 a 11 series y pesan entre 325 y 520 MB, con un máximo de 1194 MB, así que 2 de 35 no entraban en el tope de 1 GB. Traen unidades Hounsfield reales, con las que los brillos de la CBCT no sirven: con «Hueso», una serie de riñón quedaba entre −99 y 107 HU, que es tejido blando.

## Decisión y motivo

- **Cada producto dice con qué tipo de imagen se guarda la tomografía** (`imagingStudy` de los hooks del servidor y `tomography` del `productUi()`): «tomografia» en odentIA y «tomografia_computarizada» en latidIA. Es el mismo estudio de siempre, sin migrar documentos. El servidor reconoce una tomografía porque tiene su `imaging_study`, no por el nombre del tipo.
- **El visor de la médica («ct») abre en «Cortes»**, sin panorámica, arco ni pieza. El 3D solo se arma al tocar su pestaña, porque es lo más pesado. La CBCT («cbct») sigue igual.
- **Las ventanas en HU** son las de uso común en radiología (nivel/ancho; Radiopaedia, «Windowing (CT)»): Pulmón −600/1500, Partes blandas 40/400 (junta mediastino y abdomen, que son casi la misma), Hueso 400/1800 y Cerebro 40/80. Se abre con «Del archivo», la ventana que trae el estudio. Valen solo si los valores son HU: modalidad CT, con Rescale Intercept y sin otro Rescale Type (PS3.3 C.8.2.1.1). Si no lo son, se ofrece la del archivo o todo el rango. La CBCT no las usa: sus grises no tienen una escala común entre equipos.
- **La serie se elige en la barra**, en los dos productos y solo si hay más de una. Abre la mayor, como siempre. El nombre, el grosor y si es un topograma se leen del principio del primer archivo de cada serie (Range); no se guarda nada aparte. El topograma y las series de menos de 10 cortes se ven en la lista y no se eligen, porque no arman un volumen.
- **Cada medida guarda su serie** (`imaging_measurement.series_instance_uid`): cada serie es otro volumen y sus mm cuentan desde su primer corte. Si la pantalla no la dice, el servidor guarda la mayor (la de más archivos; si empatan, la del primer archivo, como la elige el visor), y la migración se la puso a las medidas de antes, que eran de esa serie, la única que se veía. Lo guardado no depende de recalcularla. El arco guardado de la CBCT también es de la serie mayor: en otra serie no se ajusta.
- **El tope sube a 1,5 GB** en los dos productos. El visor arma una serie a la vez, así que la memoria depende de la serie, no del estudio.
- **Lo orientativo, en una sola línea, sin frenar nada**: «Visor de consulta: medidas orientativas con la escala del archivo. El diagnóstico es el informe del radiólogo.»

## Alternativas descartadas

- **Encender las dos banderas y reusar el visor dental.** La subida fallaba (el tipo «tomografia» no existe en latidIA) y la panorámica por el arco no tiene sentido en un abdomen.
- **Ventanas calculadas con el histograma, como en la CBCT.** Con HU, los valores comunes son los que el médico conoce y los que usa el informe.
- **Seis ventanas** (mediastino y abdomen aparte). Casi iguales: dos botones para lo mismo.
- **Dejar 1 GB y pedir al centro las series principales.** Es la salida cuando no entra, pero obligaba a hacerlo con estudios comunes de tórax y páncreas.
- **Guardar el nombre y el grosor de cada serie al subir.** Pide otra tabla y una migración para algo que el archivo ya dice.

## Consecuencias

- Una CBCT que declara HU sin estarlo podría verse con ventanas fijas en latidIA. No ocurre en odentIA, donde la CBCT nunca las usa.
- El CT mejorado (varios cuadros en un archivo) con su escala en los grupos funcionales no se toma por HU: se ve con la ventana del archivo o con todo el rango.
- Registro como dispositivo médico o certificación diagnóstica: pendiente legal, fuera de este cambio.

## Referencias

- `packages/clinic-app/src/lib/ct-windows.ts`, `lib/cbct-series.ts`, `lib/cbct-volume.ts` (`hounsfield`, `fileWindow`), `components/patient/tomography-viewer.tsx`.
- `packages/services/src/imaging-studies.ts`, `product-hooks.ts` (`imagingStudy`).
- ADR 0055, 0056 y 0147.
