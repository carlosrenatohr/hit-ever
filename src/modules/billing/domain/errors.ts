// ============================================================================
// Billing typed errors — stable codes + HTTP status, independent of the message.
// ============================================================================
// fail() historically mapped messages to status codes by regex; rewording a
// message silently dropped it to a 500. Errors that need a guaranteed status
// and code throw this instead; the regex fallback only serves legacy throws.

export class BillingError extends Error {
  constructor(
    /** Envelope error code, e.g. 'INVOICE_CREATION_REVERTED'. */
    readonly code: string,
    message: string,
    /** HTTP status fail() responds with. Defaults to 422 (caller's request). */
    readonly status: number = 422,
  ) {
    super(message)
    this.name = 'BillingError'
  }
}
