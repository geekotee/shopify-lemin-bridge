// shopify-lemin-bridge.js
// Bridges Shopify "orders/create" webhooks to Lemin.AI WhatsApp template messages.

import crypto from "crypto";

// ---- CONFIG (set these as environment variables, never hardcode) ----
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // From Shopify webhook settings
const LEMIN_API_KEY = process.env.LEMIN_API_KEY;                   // From Lemin.AI dashboard
const LEMIN_ENDPOINT = "https://app.leminai.com/api/v1/messages/template";
const TEMPLATE_NAME = "order_confirmation"; // must match an approved Meta template
const TEMPLATE_LANGUAGE = "en_US";

// ---- Helper: verify the request really came from Shopify ----
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const generatedHash = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, "utf8")
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(generatedHash),
    Buffer.from(hmacHeader || "")
  );
}

// ---- Helper: format phone number for WhatsApp (needs country code, no +, no spaces) ----
function formatPhoneNumber(rawPhone, defaultCountryCode = "91") {
  if (!rawPhone) return null;
  let digits = rawPhone.replace(/[^\d]/g, ""); // strip everything except digits
  if (digits.length === 10) {
    digits = defaultCountryCode + digits;
  }
  return digits;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];

  if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
    console.error("Webhook verification failed — rejecting request");
    return res.status(401).send("Unauthorized");
  }

  const order = JSON.parse(rawBody);

  // ---- Extract the fields we need from the Shopify order payload ----
  const customerName =
    order.customer?.first_name || order.shipping_address?.first_name || "Customer";
  const orderNumber = order.name || order.order_number; // e.g. "#1023"
  const totalAmount = order.total_price || order.current_total_price || "0.00";
  const phone =
    order.shipping_address?.phone || order.customer?.phone || order.phone;

  const formattedPhone = formatPhoneNumber(phone);

  if (!formattedPhone) {
    console.error(`No usable phone number for order ${orderNumber}, skipping WhatsApp send`);
    return res.status(200).send("No phone number — skipped");
  }

  // ---- Build the Lemin.AI request body ----
  // Order matches template: Name -> Order Number -> Total Amount
  const leminPayload = {
    to: formattedPhone,
    template_name: TEMPLATE_NAME,
    language: TEMPLATE_LANGUAGE,
    components: [
      {
        type: "body",
        parameters: [
          { type: "text", text: customerName },
          { type: "text", text: orderNumber },
          { type: "text", text: String(totalAmount) },
        ],
      },
    ],
  };

  try {
    const leminResponse = await fetch(LEMIN_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LEMIN_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(leminPayload),
    });

    const result = await leminResponse.json();

    if (!leminResponse.ok) {
      console.error("Lemin.AI API error:", result);
      return res.status(502).send("Failed to send WhatsApp message");
    }

    console.log(`WhatsApp sent for order ${orderNumber}, WAMID: ${result.wamid || "n/a"}`);
    return res.status(200).send("OK");
  } catch (err) {
    console.error("Error calling Lemin.AI:", err);
    return res.status(500).send("Internal error");
  }
}
