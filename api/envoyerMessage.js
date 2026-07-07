"use strict";
const {
  admin, db, limiterMessage, sanitize, envoyerNotifPush,
  verifyAuth, withHandler, HttpError,
} = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
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
});
