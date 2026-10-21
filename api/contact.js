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

// ---------------------------------------------------------------------------
// Rate limiting
//
// Resend's free tier allows 100 emails/day, so an unthrottled public endpoint
// could have the quota drained by a bot. Limits are counted in fixed windows:
//
//   per IP    3 per hour, 10 per day
//   global   60 per day   <- circuit breaker, stays under Resend's 100
//
// Counters live in Upstash Redis when the integration's env vars are present,
// so they are shared across function instances. Without Redis (or if Redis is
// unreachable) it falls back to a per-instance in-memory map: weaker, but it
// still stops the common case of one bot hammering one warm instance.
//
// Redis failures fail OPEN. A broken counter should never swallow a real
// enquiry from a customer; the in-memory limiter remains as a backstop.
// ---------------------------------------------------------------------------

const LIMITS = {
  ipHour: { max: 3, windowMs: 60 * 60 * 1000, prefix: "ck:rl:ip-h" },
  ipDay: { max: 10, windowMs: 24 * 60 * 60 * 1000, prefix: "ck:rl:ip-d" },
  globalDay: { max: 60, windowMs: 24 * 60 * 60 * 1000, prefix: "ck:rl:all-d" },
};

const MIN_FILL_MS = 3000;

const REDIS_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const memory = new Map();

function memoryIncr(key, windowMs, now) {
  if (memory.size > 5000) {
    for (const [k, v] of memory) if (v.expires <= now) memory.delete(k);
  }
  const entry = memory.get(key);
  if (!entry || entry.expires <= now) {
    memory.set(key, { count: 1, expires: now + windowMs });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

async function redisIncr(key, windowMs) {
  const seconds = Math.ceil(windowMs / 1000);
  const response = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([
      ["INCR", key],
      ["EXPIRE", key, String(seconds), "NX"],
    ]),
  });
  if (!response.ok) throw new Error(`redis ${response.status}`);
  const out = await response.json();
  const count = out && out[0] && out[0].result;
  if (typeof count !== "number") throw new Error("redis: unexpected reply");
  return count;
}

// Returns the name of the first limit exceeded, or null when within limits.
async function checkLimits(ip, now) {
  const checks = [
    ["ipHour", `${LIMITS.ipHour.prefix}:${ip}`, LIMITS.ipHour],
    ["ipDay", `${LIMITS.ipDay.prefix}:${ip}`, LIMITS.ipDay],
    ["globalDay", LIMITS.globalDay.prefix, LIMITS.globalDay],
  ];

  for (const [name, baseKey, limit] of checks) {
    const bucket = Math.floor(now / limit.windowMs);
    const key = `${baseKey}:${bucket}`;
    let count;
    if (REDIS_URL && REDIS_TOKEN) {
      try {
        count = await redisIncr(key, limit.windowMs);
      } catch (error) {
        console.error("contact: redis unavailable, using memory", error.message);
        count = memoryIncr(key, limit.windowMs, now);
      }
    } else {
      count = memoryIncr(key, limit.windowMs, now);
    }
    if (count > limit.max) return name;
  }
  return null;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  if (Array.isArray(fwd) && fwd.length) return String(fwd[0]).trim();
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

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

  // Our form reports how long it was on screen before submit. A human cannot
  // complete it in under 3s; scripted posts either omit the field or fire
  // instantly. Accept silently so bots learn nothing from the response.
  const fillMs = Number(body._fillMs);
  if (!Number.isFinite(fillMs) || fillMs < MIN_FILL_MS) {
    console.warn("contact: rejected on fill time", body._fillMs);
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

  // Counted only after validation, so malformed probes cannot drain the quota.
  const exceeded = await checkLimits(clientIp(req), Date.now());
  if (exceeded) {
    console.warn("contact: rate limit hit", exceeded);
    if (exceeded === "globalDay") {
      return res.status(503).json({
        error:
          "We are receiving an unusual number of messages right now. Please email info@caribbean-key.com directly.",
      });
    }
    return res.status(429).json({
      error:
        "You have already sent a few messages. Please wait a little while, or email info@caribbean-key.com directly.",
    });
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
