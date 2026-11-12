# 0180 · La hoja membretada de la clínica

Fecha: 2026-11-11 · Estado: aceptada · Retoma la alternativa que la [0162](0162-el-color-de-la-marca-de-la-clinica.md) descartó y precisa la [0115](0115-documentos-del-paciente-con-un-solo-kit.md), la [0132](0132-lo-emitido-no-cambia.md) y la [0148](0148-la-hoja-que-se-firma-es-la-del-papel.md)

## Problema

Una clínica real que empezaba preguntó si sus papeles podían salir en su hoja membretada, la que ya usa en Word o Google Docs. Hoy cada papel sale con nuestro membrete fijo: el logo chico, el nombre, la razón social y una línea de color. La 0162 había descartado dos veces que la clínica subiera su membrete: una imagen podía decir otro RUC u otra dirección que sus datos, y su alto chocaba con la hoja. Dejó anotado revisarlo si una clínica real lo pedía.

## Decisión y motivo

- **La clínica sube su hoja (PDF, PNG o JPG) y va de fondo en todos sus papeles en hoja**: receta, orden, descanso, hoja de atención, consentimiento, presupuesto, historia, comprobante en hoja y receta de lentes, en los tres productos. El ticket térmico no la lleva. Reemplaza nuestro membrete: su diseño dice quién es. Una sola hoja para toda la clínica, que usa todo el equipo; no hay hoja por profesional ni por sede.
- **Los datos no se leen de la hoja: se ponen desde Configuración.** El PDF de la primera clínica, hecho en Google Docs, no deja leer su texto, y así muchos. Por eso no se compara lo que dice la hoja con los datos: se pide subirla sin RUC, dirección ni teléfono y el papel pone, en una línea chica bajo su diseño, la razón social (aunque sea igual al nombre) y el RUC, y la sede, la dirección y el teléfono salvo que la casilla «Mi hoja ya trae la dirección y el teléfono» diga lo contrario. Con varias sedes, el papel no es de una: lleva la dirección fiscal si la hay y ningún teléfono, y el cajón dice exactamente qué agrega. El comprobante dice siempre una dirección: la fiscal o, sin ella, la de la sede que cobró. Así no hay dos fuentes de los datos, que era el motivo de la 0162.
- **Cada papel lleva la firma y el sello de quien lo emite.** Una hoja con el nombre o la colegiatura de una persona haría que la receta de un colega salga con los dos. No se puede saber leyendo la hoja, y la decisión del dueño del producto es no bloquear: el cajón lo dice con la consecuencia y la salida (pedir una versión sin esos datos) y la vista previa muestra una receta de otro profesional del equipo, con su firma, su sello y el QR como en una de verdad.
- **El texto va donde ella dice**: lo que se deja desde cada borde, en milímetros, por los cuatro lados. El navegador dibuja la hoja (pdf.js, solo en el navegador) y lo mide solo: su diseño de arriba y de abajo termina donde aparece un hueco sin tinta de 10 mm; lo claro, como una marca de agua, no cuenta y queda debajo del texto. Se corrige arrastrando el recuadro o escribiendo los milímetros. El servidor pone un mínimo de 5 mm y deja siempre al menos tres cuartos del ancho (lo que piden, lado a lado, la firma, el sello y el QR) y el 60 % del alto (lo que pide una receta corta con su firma para caber en una hoja) para el texto; si aun así la receta de ejemplo ocupa más de una hoja, el cajón lo dice.
- **El servidor normaliza lo que sube**: se queda con la primera página de un PDF, con su recorte y su giro aplicados, y una imagen va a toda una página (A4 o Carta si tiene su forma). El papel la escala al ancho y, si su alto no coincide (una hoja Carta en un papel A4), pega su parte de abajo al borde de abajo y el resto arriba: no se deforma. Un PDF con clave o dañado se rechaza junto al archivo.
- **Cada papel usa la hoja que la clínica tenía cuando se emitió o se firmó** (`getLetterheadAt`). Cada cambio (subirla, ajustarla, quitarla, «Deshacer») es una versión en `clinic_letterhead`, que solo se agrega: la aplicación solo marca una como quitada y una quitada no vuelve. Así lo emitido no cambia aunque se guarde después (la receta cuyo guardado falló, el consentimiento firmado por enlace que se confirma más tarde) y el presupuesto, el comprobante y la receta de lentes, que se arman al abrirse, salen con la hoja de su momento. La historia exportada se emite al exportarla. Si la hoja no se puede leer, el papel sale con nuestro membrete y no se guarda todavía.
- **En pantalla, la hoja que se firma muestra su parte de arriba y la de abajo de borde a borde de un papel centrado**, y el odontograma también, sin la marca de agua bajo el gráfico de la norma; impreso, las lleva en cada página, como los PDF. El odontograma firmado guarda las de su momento en su encabezado congelado.
- **El PDF va al bucket privado; las franjas y la miniatura, al público**, rehechas en PNG por el servidor, porque las ve el paciente en la hoja que firma en su enlace.

## Alternativas descartadas

- *Comparar los datos de la hoja con los de Configuración.* El texto de muchos PDF no se puede leer; una comparación que a veces no compara promete lo que no cumple.
- *Una hoja por profesional* (el recetario de cada uno). Resolvería las dos colegiaturas, pero suma un concepto que ninguna clínica pidió todavía. Queda para cuando lo pidan.
- *Imprimir sobre papel ya impreso, sin nuestro membrete.* No es lo que pidió la clínica: quiere su hoja en el sistema, también en lo que se envía.
- *La hoja entera de fondo en la pantalla que se firma.* La marca de agua no tiene un lugar fijo en un texto que se desplaza, y en el odontograma teñiría el gráfico.

## Consecuencias

- Cabe menos por hoja (en la de la primera clínica, unos 206 mm de alto en vez de 270): la historia exportada sale más larga.
- Las versiones de la hoja y sus imágenes no se borran nunca, para que lo emitido las siga leyendo.
- Un papel lleva el peso de la hoja: una hoja pesada hace PDF pesados.
- Revisar si las clínicas piden una hoja por profesional.
