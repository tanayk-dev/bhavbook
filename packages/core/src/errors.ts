// Typed errors raised by @bhavbook/core. Messages never include caller-supplied values that may be personal data.

export class BhavbookCoreError extends Error {
  override readonly name: string = 'BhavbookCoreError';
}

/** Input text is not in the accepted format (decimal, date, rate). */
export class ParseError extends BhavbookCoreError {
  override readonly name = 'ParseError';
}

/** Input has more precision than the target unit and no rounding mode was given. */
export class PrecisionError extends BhavbookCoreError {
  override readonly name = 'PrecisionError';
}

/** An argument is outside its valid domain (non-positive divisor, negative weight, unknown mode, …). */
export class InvalidArgumentError extends BhavbookCoreError {
  override readonly name = 'InvalidArgumentError';
}
