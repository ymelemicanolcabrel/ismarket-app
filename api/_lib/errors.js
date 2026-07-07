"use strict";

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const STATUS_MAP = {
  "invalid-argument": 400,
  "unauthenticated": 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "failed-precondition": 412,
  "resource-exhausted": 429,
  "unavailable": 503,
  "internal": 500,
};

function statusFor(code) {
  return STATUS_MAP[code] || 500;
}

module.exports = { HttpError, statusFor };
