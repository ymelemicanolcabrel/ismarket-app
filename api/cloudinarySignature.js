"use strict";
const crypto = require("crypto");
const { getRole, verifyAuth, withHandler, HttpError } = require("./_lib/helpers");

module.exports = withHandler(async (data, req) => {
  const uid = await verifyAuth(req);
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
});
