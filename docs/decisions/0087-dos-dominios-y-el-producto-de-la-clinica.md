# 0087 · Dos dominios en una instalación; la clínica nace con su producto

- **Fecha:** 2026-10-24
- **Estado:** aceptada (decisiones 9 y 17 del issue 229)

## Problema

latidIA, el producto médico, vive en su propio dominio (`latidia72.com`) y odentIA en el suyo. El ADR 0079 pide una sola base, una sola API y una sola administración para los dos.

Pero la sesión, los enlaces que recibe el paciente y «Elige tu clínica» solo conocían un dominio. Además, el producto de una clínica (`org_profile.product`) no tenía quién lo fijara.

Un ejemplo: la Dra. Vela entra a `sanmartin.latidia72.com`. Hoy no podría iniciar sesión ahí, y la clínica que creara nacería dental.

## Decisión y motivo

- **Una instancia de Better Auth por dominio.** Las dos usan la misma base y el mismo secreto. `/api/auth/*` usa la del `Host` de la petición, así que cada cookie vive en su dominio. Quien trabaja en los dos productos entra una vez en cada dominio. Una cookie no puede cruzar dominios, y separar la base rompería «una persona, una historia».
- **Cada enlace sale del dominio del producto de su clínica.** Todos los enlaces públicos se arman con `clinicOrigin(slug, product)` o con `clinicOriginOf`. El panel y la clínica abren cada clínica en su dominio.
- **El producto lo fija el dominio donde nace la clínica, y no cambia después.**
  - En el alta asistida lo elige la administración.
  - La solicitud de Fundadores guarda el de su dominio, y su invitación abre el panel de ese dominio.
  - Cambiar de producto con datos clínicos dentro dejaría una historia a medias, sin odontograma o sin signos vitales.
- **Las palabras que cambian de producto viven en un solo lugar,** `productWords` de `@odentia/clinical`, para la pantalla y para el servidor:
  - quien atiende: «Odontólogo» o «Médico»;
  - lo que se reserva: «unidad dental» o «sala». En latidIA, «consultorio» es el lugar entero. Las dos palabras son femeninas, así que las frases no cambian de artículo.

  Lo que lee el modelo va aparte (`ProductAgentTexts`, ADR 0079), porque se mide antes de cambiarlo.

## Alternativas descartadas

- **Una instalación aparte para latidIA.** Duplica la base, la administración, los cobros y el despliegue, y separa a quien trabaja en los dos productos.
- **Una sola cookie para los dos dominios.** El navegador no la comparte entre dominios distintos.
- **Que el producto lo elija la clínica en el registro.** Sería una pregunta más en el alta, y podría contradecir el dominio donde entró.

## Consecuencias

- **Beneficio:** un solo código y una sola operación. La clínica médica ve sus palabras desde el primer día.
- **Sacrificio:** quien trabaja en los dos productos inicia sesión dos veces. Una pantalla nueva que nombre a quien atiende o lo que se reserva debe usar `appWords()`.
- **Pendiente fuera del código:** cada servicio externo necesita el segundo dominio (`docs/deployment.md`).
- **Cuándo revisarlo:** si un tercer producto necesita palabras con otro género o una lista de palabras más larga.

## Referencias

- `packages/services/src/product-domains.ts` y `public-links.ts`.
- `apps/api/src/app.ts` (`authOf`, `productOfRequest`, `panelUrlOf`).
- `packages/clinical/src/product-words.ts` y `packages/clinic-app/src/lib/product-words.ts`.
- `docs/deployment.md`, sección «latidIA en su dominio».
