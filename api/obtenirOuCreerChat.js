"use strict";
const { admin, db, verifyAuth, withHandler, HttpError } = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  const { vendorId, productId } = data;
  if (!vendorId || vendorId === uid) throw new HttpError("invalid-argument", "Vendeur invalide.");

  const chatSnap = await db.collection("chats")
    .where("participants", "array-contains", uid)
    .where("productId", "==", productId).limit(1).get();
  if (!chatSnap.empty) return { chatId: chatSnap.docs[0].id };

  const [productDoc, buyerDoc, vendorDoc] = await Promise.all([
    db.collection("products").doc(productId).get(),
    db.collection("users").doc(uid).get(),
    db.collection("users").doc(vendorId).get(),
  ]);

  const ref = await db.collection("chats").add({
    participants: [uid, vendorId],
    buyerId: uid, vendorId, productId,
    productName: productDoc.exists ? productDoc.data().name : "Produit",
    buyerName:   buyerDoc.exists ? buyerDoc.data().name : "Acheteur",
    vendorName:  vendorDoc.exists ? vendorDoc.data().name : "Vendeur",
    lastMessage: "", lastAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    [`unread_${uid}`]: 0, [`unread_${vendorId}`]: 0,
  });
  return { chatId: ref.id };
});
