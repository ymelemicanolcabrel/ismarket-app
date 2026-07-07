"use strict";
const {
  admin, db, getRole, envoyerNotifFirestore, verifyAuth, withHandler, HttpError,
} = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  const { orderId, newStatus } = data;
  const validStatuses = ["confirmed", "shipped", "delivered", "cancelled"];
  if (!validStatuses.includes(newStatus)) throw new HttpError("invalid-argument", "Statut invalide.");

  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) throw new HttpError("not-found", "Commande introuvable.");
  const order = orderDoc.data();

  const role = await getRole(uid);
  if (order.vId !== uid && role !== "admin") throw new HttpError("permission-denied", "Non autorisé.");
  if (order.paymentStatus !== "PAID") throw new HttpError("failed-precondition", "Paiement non confirmé.");

  await db.collection("orders").doc(orderId).update({
    orderStatus: newStatus,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const statusLabels = { confirmed: "confirmée", shipped: "expédiée", delivered: "livrée", cancelled: "annulée" };
  const statusIcons  = { confirmed: "✅", shipped: "🚚", delivered: "🎉", cancelled: "❌" };
  if (order.buyerId) {
    await envoyerNotifFirestore(order.buyerId, "order",
      `${statusIcons[newStatus]} Commande ${statusLabels[newStatus]}`,
      `Votre commande "${order.productName}" est ${statusLabels[newStatus]}.`,
      { orderId });
  }

  return { success: true };
});
