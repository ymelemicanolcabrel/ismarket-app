"use strict";
const fetch = require("node-fetch");
const { db, MONETBIL_BASE, verifyAuth, withHandler, HttpError } = require("./_lib/helpers");
const { traiterWebhookCommande } = require("./_lib/webhookLogic");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  const { orderId } = data;
  const orderDoc = await db.collection("orders").doc(orderId).get();
  if (!orderDoc.exists) throw new HttpError("not-found", "Commande introuvable.");
  const order = orderDoc.data();
  if (order.buyerId !== uid) throw new HttpError("permission-denied", "Non autorisé.");

  if (order.paymentStatus === "PENDING" && order.paymentRef) {
    try {
      const SERVICE_KEY = process.env.MONETBIL_KEY;
      const res = await fetch(
        `${MONETBIL_BASE}/payment/v1/checkPayment?service=${SERVICE_KEY}&paymentRef=${order.paymentRef}`
      );
      const remote = await res.json();
      if (remote.status && remote.status !== "pending") {
        const statusMap = { success: "PAID", failed: "FAILED", cancelled: "CANCELLED", expired: "EXPIRED" };
        const newStatus = statusMap[remote.status] || order.paymentStatus;
        if (newStatus !== order.paymentStatus) {
          await traiterWebhookCommande(orderId, newStatus);
          return { paymentStatus: newStatus, orderStatus: newStatus === "PAID" ? "confirmed" : "cancelled" };
        }
      }
    } catch (_) {}
  }

  return { paymentStatus: order.paymentStatus, orderStatus: order.orderStatus };
});
