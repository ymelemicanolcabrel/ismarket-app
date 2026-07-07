"use strict";
const { admin, db, sanitize, verifyAuth, withHandler, HttpError } = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  const { targetId, targetType, reason } = data;
  if (!["product", "user"].includes(targetType)) throw new HttpError("invalid-argument", "Type invalide.");

  await db.collection("reports").add({
    reporterId: uid, targetId, targetType,
    reason: sanitize(reason || "", 300),
    createdAt: admin.firestore.FieldValue.serverTimestamp(), resolved: false,
  });

  const col = targetType === "product" ? "products" : "users";
  await db.collection(col).doc(targetId).update({
    reportCount: admin.firestore.FieldValue.increment(1),
  }).catch(() => {});

  return { success: true };
});
