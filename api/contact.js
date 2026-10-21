// Contact form handler. Receives submissions from the Framer-exported form in
// index.html and relays them by email via Resend.
//
// Env (set on the Vercel project by the Resend marketplace integration):
//   RESEND_API_KEY       - required
//   RESEND_EMAIL_DOMAIN  - verified sending domain, e.g. caribbean-key.com
//   CONTACT_TO_EMAIL     - optional recipient override
//   CONTACT_FROM_EMAIL   - optional sender override

const TO_EMAIL = process.env.CONTACT_TO_EMAIL || "info@caribbean-key.com";

const FROM_EMAIL =
  process.env.CONTACT_FROM_EMAIL ||
  (process.env.RESEND_EMAIL_DOMAIN
    ? `website@${process.env.RESEND_EMAIL_DOMAIN}`
    : null);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Framer renders decoy inputs with these exact lowercase names. The real fields are
// capitalized (Name, Email, Phone, Websiste, Message), so the casing is significant:
// a filled lowercase field means a bot walked the form.
const HONEYPOTS = [
  "website",
  "company",
  "message",
  "subject",
  "title",
  "description",
  "feedback",
  "notes",
  "details",
  "remarks",
  "comments",
];

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const row = (label, value) =>
  `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;vertical-align:top">${label}</td>` +
  `<td style="padding:6px 0;color:#111827;font-size:14px">${escapeHtml(value)}</td></tr>`;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("contact: RESEND_API_KEY is not set");
    return res.status(500).json({ error: "Email service is not configured." });
  }
  if (!FROM_EMAIL) {
    console.error("contact: no sending domain (RESEND_EMAIL_DOMAIN unset)");
    return res.status(500).json({ error: "Email service is not configured." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "Invalid request body." });
    }
  }
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "Invalid request body." });
  }

  // Any filled decoy: accept silently so the bot sees success and does not retry.
  if (HONEYPOTS.some((key) => String(body[key] || "").trim())) {
    console.warn("contact: honeypot triggered, discarding submission");
    return res.status(200).json({ ok: true });
  }

  const str = (key) => String(body[key] == null ? "" : body[key]).trim();
  const name = str("Name");
  const email = str("Email");
  const phone = str("Phone");
  const website = str("Websiste") || str("Website");
  const message = str("Message");

  if (!name) {
    return res.status(400).json({ error: "Please enter your name." });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  if (name.length > 200 || email.length > 320 || message.length > 5000) {
    return res.status(400).json({ error: "That submission is too long." });
  }

  const rows = [
    row("Name", name),
    row("Email", email),
    phone ? row("Phone", phone) : "",
    website ? row("Website", website) : "",
  ].join("");

  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:600px">
      <h2 style="margin:0 0 4px;font-size:18px;color:#111827">New website enquiry</h2>
      <p style="margin:0 0 20px;color:#6b7280;font-size:13px">Submitted via the caribbean-key.com contact form.</p>
      <table style="border-collapse:collapse;margin-bottom:20px">${rows}</table>
      ${
        message
          ? `<div style="border-top:1px solid #e5e7eb;padding-top:16px">
               <p style="margin:0 0 6px;color:#6b7280;font-size:13px">Message</p>
               <p style="margin:0;color:#111827;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(message)}</p>
             </div>`
          : ""
      }
    </div>
  `;

  const text = [
    "New website enquiry",
    "",
    `Name: ${name}`,
    `Email: ${email}`,
    phone ? `Phone: ${phone}` : "",
    website ? `Website: ${website}` : "",
    message ? `\nMessage:\n${message}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Caribbean Key Mortgages <${FROM_EMAIL}>`,
        to: [TO_EMAIL],
        reply_to: email,
        subject: `New enquiry from ${name}`,
        html,
        text,
      }),
    });

    if (!response.ok) {
      console.error("contact: resend failed", response.status, await response.text());
      return res.status(502).json({
        error: "We could not send your message. Please email info@caribbean-key.com directly.",
      });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("contact: resend threw", error);
    return res.status(502).json({
      error: "We could not send your message. Please email info@caribbean-key.com directly.",
    });
  }
};
