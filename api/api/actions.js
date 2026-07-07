"use strict";
const { verifyAuth, withHandler, HttpError } = require("./_lib/helpers");
const handlers = require("./_lib/actionHandlers");

module.exports = withHandler(async (body, req) => {
  const uid = await verifyAuth(req);
  const { action, payload } = body;
  const fn = handlers[action];
  if (!fn) throw new HttpError("invalid-argument", "Action inconnue.");
  return fn(payload || {}, uid);
});
