# 0049. Los términos los acepta cada persona; el contrato de encargo, la clínica

- **Fecha:** 2026-10-17
- **Estado:** aceptada (lienzo «Términos con Google», cuatro decisiones aprobadas por el usuario).

## Problema

Crear cuenta con correo guardaba la aceptación de los documentos; entrar con Google no guardaba nada, y nadie volvía a aceptar si los documentos cambiaban. Además se pedía el contrato de encargo de tratamiento a todos, también a quien solo trabaja en una clínica.

## Decisión y motivo

- **Términos del servicio y Aviso de privacidad:** los acepta cada persona, con casilla, y se guarda versión y hora (`user.terms_version`, `terms_accepted_at`). Quien nunca aceptó (Google, cuentas anteriores) pasa por «Un paso antes de seguir» antes de entrar.
- **Contrato de encargo de tratamiento:** lo acepta la clínica, porque es ella quien confía a odentIA los datos de sus pacientes. Lo acepta quien la abre (se copia al crearla) o quien la administra (`settings.write`); queda quién y cuándo en `processing_agreement_acceptance`, una fila por versión.
- **Versiones:** viven en `packages/auth/src/legal.ts` y cambian solo cuando cambia algo que importa. Una versión nueva se pide al entrar con una ventana que no se cierra sin aceptar, y quienes aceptaron la anterior reciben un correo antes de que rija (reservado antes de enviarse: no se repite).

## Alternativas descartadas

- **Frase bajo el botón de Google** («al continuar aceptas…»): un clic menos, pero no prueba que se marcó.
- **Que todo el equipo acepte el contrato de encargo:** el contrato es entre la clínica y odentIA; firmarlo cada recepcionista no lo hace más válido.
- **Dar un plazo para aceptar una versión nueva sin bloquear:** deja periodos con personas trabajando bajo términos no aceptados.

## Consecuencias

Quien no acepta una versión nueva no puede seguir trabajando hasta hacerlo; puede escribir a soporte. Si la clínica no aceptó el contrato (cuenta anterior o abierta por alguien que entró invitado), quien la administra lo ve al entrar. Revisar si los textos legales finales piden firmas distintas por país.

## Referencias

- `packages/auth/src/legal.ts`, `packages/auth/src/terms.ts`, `packages/services/src/legal.ts`, `apps/worker/src/legal-notices.ts`.
- `apps/panel/src/routes/terminos.tsx`, `packages/ui-patterns/src/legal-gate.tsx`, `packages/services/src/legal.test.ts`, `e2e/terms.spec.ts`.
