"use strict";
const {
  admin, db, COMMISSION_RATE, envoyerNotifFirestore, mettreAJourBadgesProduits,
} = require("./helpers");

async function traiterWebhookCommande(orderId, newStatus) {
  const orderRef = db.collection("orders").doc(orderId);
  const orderDoc = await orderRef.get();
  if (!orderDoc.exists) return;
  const order = orderDoc.data();

  const orderStatus = newStatus === "PAID" ? "confirmed"
    : ["CANCELLED", "FAILED", "EXPIRED"].includes(newStatus) ? "cancelled" : "pending";
  await orderRef.update({ paymentStatus: newStatus, orderStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  const paySnap = await db.collection("payments").where("orderId", "==", orderId).limit(1).get();
  if (!paySnap.empty) {
    await paySnap.docs[0].ref.update({ status: newStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  }

  if (newStatus === "PAID") {
    if (order.vId && order.vId !== "system") {
      const commission = Math.round((order.totalPrice || 0) * COMMISSION_RATE);
      const net = (order.totalPrice || 0) - commission;
      await db.collection("users").doc(order.vId).update({
        walletBalance: admin.firestore.FieldValue.increment(net),
      });
      await db.collection("wallet_transactions").add({
        vendorId: order.vId, orderId, type: "sale",
        amount: net, commission, totalSale: order.totalPrice,
        productName: order.productName,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await db.collection("platform_revenue").add({
        orderId, amount: commission, type: "commission",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (order.productId) {
        await db.collection("products").doc(order.productId).update({
          soldCount: admin.firestore.FieldValue.increment(1),
        }).catch(() => {});
      }
      await envoyerNotifFirestore(order.vId, "sale", "💰 Nouvelle vente !",
        `${order.productName} — ${net.toLocaleString("fr-FR")} F CFA crédités.`, { orderId });
    }
    if (order.buyerId) {
      await envoyerNotifFirestore(order.buyerId, "payment", "✅ Paiement confirmé !",
        `Votre commande "${order.productName}" a été confirmée.`, { orderId });
    }
  } else if (["FAILED", "CANCELLED", "EXPIRED"].includes(newStatus) && order.buyerId) {
    await envoyerNotifFirestore(order.buyerId, "payment", "❌ Paiement échoué",
      `Le paiement pour "${order.productName}" a échoué (${newStatus.toLowerCase()}).`, { orderId });
  }
}

async function traiterWebhookAbonnement(subPayId, newStatus) {
  const docId = String(subPayId).replace("sub_", "");
  const subRef = db.collection("subscription_payments").doc(docId);
  const subDoc = await subRef.get();
  if (!subDoc.exists) return;
  const subData = subDoc.data();

  await subRef.update({ status: newStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  if (newStatus === "PAID" && subData.vendorId) {
    const now = new Date();
    const vendorDoc = await db.collection("users").doc(subData.vendorId).get();
    const vendorData = vendorDoc.exists ? vendorDoc.data() : {};
    let baseDate = now;
    if (vendorData.subscriptionStatus === "premium" && vendorData.subscriptionExpiry) {
      const currentExpiry = vendorData.subscriptionExpiry.toDate?.() || new Date(vendorData.subscriptionExpiry);
      if (currentExpiry.getTime() > now.getTime()) baseDate = currentExpiry;
    }
    const newExpiry = new Date(baseDate);
    newExpiry.setMonth(newExpiry.getMonth() + 1);

    await db.collection("users").doc(subData.vendorId).update({
      subscriptionStatus: "premium",
      subscriptionExpiry: newExpiry,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await mettreAJourBadgesProduits(subData.vendorId, { vendorPremium: true, vendorTrial: false });

    await envoyerNotifFirestore(subData.vendorId, "subscription", "🌟 Abonnement Premium activé !",
      `Votre abonnement est actif jusqu'au ${newExpiry.toLocaleDateString("fr-FR")}.`, {});
  } else if (["FAILED", "CANCELLED", "EXPIRED"].includes(newStatus) && subData.vendorId) {
    await envoyerNotifFirestore(subData.vendorId, "subscription", "❌ Paiement abonnement échoué",
      `Le paiement de votre abonnement a échoué (${newStatus.toLowerCase()}).`, {});
  }
}

module.exports = { traiterWebhookCommande, traiterWebhookAbonnement };
