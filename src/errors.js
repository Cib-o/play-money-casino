/**
 * Application error carrying an HTTP status and a stable error code.
 * Codes double as i18n keys (err_*) so the client renders them in the
 * active language and no user-facing English leaks out of the API.
 */
export class AppError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.statusCode = statusCode;
    this.code = code;
  }
}
