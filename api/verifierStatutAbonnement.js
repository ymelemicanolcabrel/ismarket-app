"use strict";
const fetch = require("node-fetch");
const { db, MONETBIL_BASE, verifyAuth, withHandler, HttpError } = require("./_lib/helpers");
const { traiterWebhookAbonnement } = require("./_lib/webhookLogic");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
  const { subPayId } = data;
  const subDoc = await db.collection("subscription_payments").doc(subPayId).get();
  if (!subDoc.exists) throw new HttpError("not-found", "Paiement introuvable.");
  const subData = subDoc.data();
  if (subData.vendorId !== uid) throw new HttpError("permission-denied", "Non autorisé.");

  if (subData.status === "PENDING" && subData.monetbilRef) {
    try {
      const SERVICE_KEY = process.env.MONETBIL_KEY;
      const res = await fetch(
        `${MONETBIL_BASE}/payment/v1/checkPayment?service=${SERVICE_KEY}&paymentRef=${subData.monetbilRef}`
      );
      const remote = await res.json();
      if (remote.status && remote.status !== "pending") {
        const statusMap = { success: "PAID", failed: "FAILED", cancelled: "CANCELLED", expired: "EXPIRED" };
        const newStatus = statusMap[remote.status] || subData.status;
        if (newStatus !== subData.status) {
          await traiterWebhookAbonnement(`sub_${subPayId}`, newStatus);
          const userDoc = await db.collection("users").doc(uid).get();
          return { status: newStatus, userData: userDoc.exists ? userDoc.data() : null };
        }
      }
    } catch (_) {}
  }

  return { status: subData.status };
});
