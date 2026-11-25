/**
 * Las pantallas de la cuenta, las mismas en todas las apps del grupo (ADR 0216): Mi perfil
 * (nombre, foto, correo, contraseña, dos pasos, sesiones y cerrar la cuenta) y Soporte de la
 * cuenta. Cada app las sirve en su dominio con `AccountProvider`.
 */
export {
  AUTH_NETWORK,
  type AuthClientError,
  type AuthErrorRoute,
  type AuthFailure,
  authError,
  authErrorMessage,
  authFailureOf,
  authFormMessage,
  type HonoAuthErrorBody,
} from "./auth-error.js"
export {
  type AccountClient,
  type AccountClientError,
  AccountProvider,
  AccountRequestError,
  type AccountServices,
  type AccountSessionRow,
  accountFetch,
  useAccount,
  useAccountFetch,
} from "./context.js"
export {
  type AccountCloseOptions,
  type AccountProfileEdit,
  AccountProfilePage,
  type AccountProfilePageProps,
  type AccountProfileUser,
  CLOSE_ACCOUNT_BLOCKER_ID,
  isAccountProfileEdit,
} from "./profile.js"
export {
  AccountCaseSkeleton,
  AccountCasesSkeleton,
  AccountTextSm,
  AccountTextXs,
  SessionsSkeleton,
  TwoFactorSkeleton,
} from "./skeletons.js"
export {
  type AccountCaseDetail,
  type AccountGrant,
  type AccountSupportIntro,
  AccountSupportPage,
  type AccountSupportPageProps,
} from "./support.js"
export {
  TWO_FACTOR_EDITS,
  TWO_FACTOR_KEY,
  type TwoFactorEdit,
  type TwoFactorStatus,
  useTwoFactorStatus,
} from "./two-factor.js"
export { parseUserAgent, relativeTime } from "./user-agent.js"
