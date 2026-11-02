# 0131 · La firma que se ve en el papel

Fecha: 2026-11-01 · Estado: aceptada · Ajusta [0033](0033-documentos-de-la-atencion-en-un-solo-lugar.md), [0036](0036-nucleo-internacional-y-lo-que-solo-es-de-peru.md) y [0115](0115-documentos-del-paciente-con-un-solo-kit.md)

## Problema

Receta, orden, descanso, consentimiento, presupuesto y odontograma terminaban en el nombre, la colegiatura y «Firmado electrónicamente», sin firma y sin línea donde firmar. El dueño del producto lo juzgó: el papel se ve mal. Los ADR 0033 y 0115 habían descartado el trazo del profesional porque no suma valor legal; eso sigue siendo cierto, pero el motivo ahora es otro: cómo se ve lo que se entrega.

## Decisión y motivo

- **Se dibuja una vez, en el perfil profesional, y sale sola** en cada papel que la persona emite, sobre una línea, con su nombre y su colegiatura debajo. Quien atiende no entra a Configuración, así que el cierre de la atención es donde la agrega o la cambia; avisa y no impide cerrar.
- **Sin firma guardada, una línea para firmar a mano:** el papel no se ve a medias y se puede firmar al imprimir.
- **Solo la propia persona la guarda y la recibe.** Administración sigue pudiendo corregir los datos de otro perfil, nunca su firma. Las rutas de datos de receta, orden y descanso no la entregan: la hoja es el PDF. La del odontograma firmado sí, porque esa hoja se dibuja en el navegador.
- **Cada papel lleva la que regía al emitirse.** `professional_drawn_signature` solo se agrega (la aplicación no puede corregir ni borrar) y cada papel la busca por quien lo emitió y su fecha. El consentimiento la copia al firmar en `professional_signature`, que ya existía, porque su PDF se guarda con su huella. Firmado en papel no la copia: ya firmó a mano en la hoja.
- **Se mantienen «Firmado electrónicamente» y el QR**, para que nadie crea que se firmó a mano o que es firma digital.

## Alternativas descartadas

- *Copiar el trazo a cada documento.* Pondría un dato pesado en filas que se listan y que llegan a otras pantallas, y obliga a tocar cada operación que emite.
- *Leer siempre la firma de hoy.* Cambiarla reescribiría lo ya emitido.
- *Subir una foto de la firma.* Pide recortar y limpiar el fondo. Se revisa si dibujarla no queda bien.
- *Que administración la cargue por el equipo.* Sería firmar por otra persona.

## Consecuencias

- Los papeles se ven firmados, y lo emitido antes de guardar una firma sale con la línea para firmar a mano. Los consentimientos ya guardados no se tocan.
- El dibujo sale en un PDF que circula y se puede copiar: es solo apariencia y no prueba quién firmó. No cambia el nivel: sigue siendo firma electrónica simple.
- Pendiente legal: la firma digital con certificado sigue fuera de esto (issue 47). Este dibujo puede ser su parte visible cuando exista.

## Referencias

`packages/services/src/professional-profiles.ts` (`setProfessionalProfile`, `drawnSignatureAt`), `packages/services/src/document-kit.ts` (`signedBlock`, `drawStrokes`), `packages/clinical/src/signature-path.ts`, `packages/clinic-app/src/components/professional-profile-drawer.tsx`, `apps/dental-clinic/src/components/dental/odontogram-sheet.tsx`, migraciones `0040` y `0041`.
