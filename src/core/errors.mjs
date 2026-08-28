export class StudioError extends Error {
  constructor(code, message, details = undefined) {
    super(message, details?.cause ? { cause: details.cause } : undefined);
    this.name = 'StudioError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function studioAssert(condition, code, message, details) {
  if (!condition) throw new StudioError(code, message, details);
}

export function asStudioError(error, fallbackCode = 'internal_error') {
  if (error instanceof StudioError) return error;
  return new StudioError(fallbackCode, error?.message ?? String(error), {
    cause: error,
  });
}
