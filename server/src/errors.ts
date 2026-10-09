export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** Extra fields returned with the error, e.g. the conflicting values. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const unauthorized = (msg = 'Not authenticated') => new HttpError(401, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg: string, details?: Record<string, unknown>) => new HttpError(409, msg, details);
