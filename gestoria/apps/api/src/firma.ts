/**
 * Standard Webhooks v1 (https://www.standardwebhooks.com): lo que la cuenta firma y gestorIA
 * comprueba, y lo que gestorIA firma al preguntarle a la cuenta y al hablar con la
 * administración (el acuerdo, ADR 0211). Es la firma de uso general de `@odentia/contract`
 * (`shared/`): una sola para todos, sin código de las clínicas.
 */
export {
  isSigningSecret,
  signMessage,
  verifySignedMessage as verifyMessage,
} from "@odentia/contract/signing"
