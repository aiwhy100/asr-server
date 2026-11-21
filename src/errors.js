export class HttpError extends Error {
  /** @param {number} statusCode @param {string} message */
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const httpError = (statusCode, message) => new HttpError(statusCode, message);
