"use strict";
// Ce fichier regroupe la logique de plusieurs actions "secondaires" (qui ont
// toutes un repli client automatique en cas d'indisponibilité) afin de rester
// sous la limite de 12 fonctions serverless du plan gratuit Vercel.
// Il est dans _lib donc n'est PAS compté comme une fonction à part.
const crypto = require("crypto");
const {
  admin, db, limiterMessage, limiterProduit,
  sanitize, getUser, getRole, estAbonnementActif, envoyerNotifPush,
  HttpError,
} = require("./helpers");

async function noterProduit(data, uid) {
  const { productId, note, commentaire } = data;
  const noteNum = Number(note);
  if (!productId || isNaN(noteNum) || noteNum < 1 || noteNum > 5)
    throw new HttpError("invalid-argument", "Note invalide (1–5).");

  const orderSnap = await db.collection("orders")
    .where("buyerId", "==", uid).where("productId", "==", productId)
    .where("paymentStatus", "==", "PAID").limit(1).get();
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
}

async function obtenirOuCreerChat(data, uid) {
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
}

async function envoyerMessage(data, uid) {
  try { await limiterMessage.consume(uid); }
  catch { throw new HttpError("resource-exhausted", "Trop de messages."); }

  const { chatId, texte } = data;
  const texteClean = sanitize(texte, 1000);
  if (!texteClean) throw new HttpError("invalid-argument", "Message vide.");

  const chatDoc = await db.collection("chats").doc(chatId).get();
  if (!chatDoc.exists) throw new HttpError("not-found", "Conversation introuvable.");
  const chat = chatDoc.data();
  if (!chat.participants.includes(uid)) throw new HttpError("permission-denied", "Accès refusé.");

  const userDoc = await db.collection("users").doc(uid).get();
  const senderName = userDoc.exists ? userDoc.data().name : "Utilisateur";

  await db.collection("chats").doc(chatId).collection("messages").add({
    senderId: uid, senderName, texte: texteClean,
    createdAt: admin.firestore.FieldValue.serverTimestamp(), read: false,
  });

  const otherId = chat.participants.find(p => p !== uid);
  await db.collection("chats").doc(chatId).update({
    lastMessage: texteClean,
    lastAt: admin.firestore.FieldValue.serverTimestamp(),
    [`unread_${otherId}`]: admin.firestore.FieldValue.increment(1),
  });

  await envoyerNotifPush(otherId, `💬 ${senderName}`, texteClean.slice(0, 80), { type: "chat", chatId });
  return { success: true };
}

async function signalerContenu(data, uid) {
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
}

async function mettreAJourStatutCommande(data, uid) {
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

  const { envoyerNotifFirestore } = require("./helpers");
  const statusLabels = { confirmed: "confirmée", shipped: "expédiée", delivered: "livrée", cancelled: "annulée" };
  const statusIcons  = { confirmed: "✅", shipped: "🚚", delivered: "🎉", cancelled: "❌" };
  if (order.buyerId) {
    await envoyerNotifFirestore(order.buyerId, "order",
      `${statusIcons[newStatus]} Commande ${statusLabels[newStatus]}`,
      `Votre commande "${order.productName}" est ${statusLabels[newStatus]}.`,
      { orderId });
  }
  return { success: true };
}

async function cloudinarySignature(data, uid) {
  const role = await getRole(uid);
  if (!["vendor", "admin"].includes(role))
    throw new HttpError("permission-denied", "Réservé aux vendeurs.");

  const timestamp = Math.round(Date.now() / 1000);
  const apiSecret = process.env.CLOUDINARY_SECRET;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const folder    = data.folder || "ismarket/products";

  const toSign    = `folder=${folder}&timestamp=${timestamp}${apiSecret}`;
  const signature = crypto.createHash("sha1").update(toSign).digest("hex");

  return { signature, timestamp, apiKey, cloudName, folder };
}

async function publierProduit(data, uid) {
  try { await limiterProduit.consume(uid); }
  catch { throw new HttpError("resource-exhausted", "Trop de publications. Attendez 1 minute."); }

  const vendor = await getUser(uid);
  if (!["vendor", "admin"].includes(vendor.role))
    throw new HttpError("permission-denied", "Réservé aux vendeurs.");
  if (vendor.isSuspended) throw new HttpError("permission-denied", "Compte suspendu.");
  if (vendor.role === "vendor" && !estAbonnementActif(vendor))
    throw new HttpError("permission-denied", "Abonnement expiré.");

  const name     = sanitize(data.name, 120);
  const desc     = sanitize(data.description, 1000);
  const imageUrl = sanitize(data.imageUrl, 500);
  const price    = Number(data.price);
  const category = sanitize(data.category, 50);
  const city     = sanitize(data.city || "", 60);
  const lat      = typeof data.lat === "number" ? data.lat : null;
  const lng      = typeof data.lng === "number" ? data.lng : null;

  if (!name || name.length < 3) throw new HttpError("invalid-argument", "Nom invalide.");
  if (isNaN(price) || price < 100 || price > 10000000) throw new HttpError("invalid-argument", "Prix invalide.");
  const validCats = ["electronique", "mode", "sante", "alimentation", "maison", "autre"];
  if (!validCats.includes(category)) throw new HttpError("invalid-argument", "Catégorie invalide.");

  const isPremium = vendor.subscriptionStatus === "premium" && estAbonnementActif(vendor);
  const isTrial   = vendor.subscriptionStatus === "trial"   && estAbonnementActif(vendor);

  const ref = await db.collection("products").add({
    name, description: desc, price, category, city, lat, lng,
    image: imageUrl,
    vId: uid, vendorName: vendor.name,
    vendorCertified: vendor.isCertified || false,
    vendorPremium: isPremium,
    vendorTrial: isTrial,
    rating: 0, reviewCount: 0, soldCount: 0,
    active: true, reported: false, reportCount: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, productId: ref.id };
}

module.exports = {
  noterProduit, obtenirOuCreerChat, envoyerMessage, signalerContenu,
  mettreAJourStatutCommande, cloudinarySignature, publierProduit,
};
