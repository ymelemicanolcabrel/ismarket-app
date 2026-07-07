"use strict";
const { traiterWebhookCommande, traiterWebhookAbonnement } = require("./_lib/webhookLogic");

const STATUS_MAP = {
  success: "PAID", failed: "FAILED", cancelled: "CANCELLED", expired: "EXPIRED", pending: "PENDING",
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  const body = req.body || {};
  const { order_id, status } = body;
  if (!order_id || !status) return res.status(400).send("Paramètres manquants");

  const key = String(status).toLowerCase();
  if (!STATUS_MAP[key]) return res.status(400).send("Statut invalide");
  const newStatus = STATUS_MAP[key];

  try {
    if (String(order_id).startsWith("sub_")) {
      await traiterWebhookAbonnement(order_id, newStatus);
    } else {
      await traiterWebhookCommande(order_id, newStatus);
    }
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).send("Erreur serveur");
  }
};
