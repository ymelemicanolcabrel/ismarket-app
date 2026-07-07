"use strict";
const { admin, db, sanitize, verifyAuth, withHandler, HttpError } = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  const { productId, note, commentaire } = data;
  const noteNum = Number(note);
  if (!productId || isNaN(noteNum) || noteNum < 1 || noteNum > 5)
    throw new HttpError("invalid-argument", "Note invalide (1–5).");

  const orderSnap = await db.collection("orders")
    .where("buyerId", "==", uid)
    .where("productId", "==", productId)
    .where("paymentStatus", "==", "PAID")
    .limit(1).get();
  if (orderSnap.empty) throw new HttpError("permission-denied", "Achat requis pour noter.");

  const existing = await db.collection("reviews")
    .where("buyerId", "==", uid).where("productId", "==", productId).limit(1).get();
  if (!existing.empty) throw new HttpError("already-exists", "Déjà noté.");

  const userDoc = await db.collection("users").doc(uid).get();
  const commentClean = sanitize(commentaire || "", 500);

  await db.collection("reviews").add({
    buyerId: uid,
    buyerName: userDoc.exists ? userDoc.data().name : "Acheteur",
    productId, note: noteNum, commentaire: commentClean,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const allReviews = await db.collection("reviews").where("productId", "==", productId).get();
  const total = allReviews.docs.reduce((s, d) => s + (d.data().note || 0), 0);
  const avg = +(total / allReviews.size).toFixed(1);
  await db.collection("products").doc(productId).update({ rating: avg, reviewCount: allReviews.size });

  return { success: true };
});
