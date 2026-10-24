import dotenv from "dotenv";
dotenv.config();

let cachedAccessToken = null;
let accessTokenExpiresAt = 0;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const clientId = requiredEnv("GMAIL_CLIENT_ID");
  const clientSecret = requiredEnv("GMAIL_CLIENT_SECRET");
  const refreshToken = requiredEnv("GMAIL_REFRESH_TOKEN");

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    console.error("GMAIL TOKEN ERROR:", data.error || response.status);
    throw new Error(`Gmail OAuth token request failed (${response.status}).`);
  }

  cachedAccessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  return cachedAccessToken;
}

function encodeBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function escapeHeader(value = "") {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function makeRawMessage({ to, subject, text, html }) {
  const from = `"ZenTalk" <${requiredEnv("EMAIL")}>`;;
  const safeTo = escapeHeader(to);
  const safeFrom = escapeHeader(from);
  const safeSubject = `=?UTF-8?B?${Buffer.from(escapeHeader(subject)).toString("base64")}?=`;
  const boundary = `zentalk_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const headers = [
    `From: ${safeFrom}`,
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    "MIME-Version: 1.0",
  ];

  let mime;
  if (html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    mime = [
      ...headers,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(text || "", "utf8").toString("base64"),
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(html, "utf8").toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("Content-Transfer-Encoding: base64");
    mime = [...headers, "", Buffer.from(text || "", "utf8").toString("base64"), ""].join("\r\n");
  }

  return encodeBase64Url(mime);
}

export async function getMailer() {
  return {
    sendMail: sendMail,
    verify: async () => {
      await getAccessToken();
      return true;
    },
  };
}

export async function verifyMailer() {
  try {
    await getAccessToken();
    requiredEnv("EMAIL");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function sendMail(message) {
  try {
    const accessToken = await getAccessToken();
    const raw = makeRawMessage(message);
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("GMAIL SEND ERROR:", data.error?.message || response.status);
      return { ok: false, reason: `Gmail API request failed (${response.status}).` };
    }
    return { ok: true, id: data.id };
  } catch (error) {
    console.error("GMAIL SEND ERROR:", error.message);
    return { ok: false, reason: error.message };
  }
}

function getBackendPublicUrl() {
  return (process.env.BACKEND_PUBLIC_URL || "").replace(/\/$/, "");
}

function getFrontendPublicUrl() {
  return (process.env.FRONTEND_PUBLIC_URL || "").replace(/\/$/, "");
}

export async function sendLoginAlert({ to, name, username }) {
  return sendMail({
    to,
    subject: "ZenTalk login alert",
    text: `Hello ${name || username},\n\nYour ZenTalk account was just signed in successfully.\n\nUsername: ${username}\nTime: ${new Date().toISOString()}\n\nIf this was not you, please change your password immediately.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827"><h2>ZenTalk login alert</h2><p>Hello ${name || username},</p><p>Your ZenTalk account was just signed in successfully.</p><p><strong>Username:</strong> ${username}</p><p><strong>Time:</strong> ${new Date().toISOString()}</p><p>If this was not you, please change your password immediately.</p></div>`,
  });
}

export async function sendWelcomeEmail({ to, name, username }) {
  return sendMail({
    to,
    subject: "Welcome to ZenTalk",
    text: `Hello ${name || username},\n\nWelcome to ZenTalk. Your account is now ready.\n\nUsername: ${username}\n\nYou can now sign in and start chatting in real time.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827"><h2>Welcome to ZenTalk</h2><p>Hello ${name || username},</p><p>Your ZenTalk account is now ready.</p><p><strong>Username:</strong> ${username}</p><p>You can now sign in and start chatting in real time.</p></div>`,
  });
}

export async function sendSignupOtpEmail({ to, name, otp }) {
  return sendMail({
    to,
    subject: "ZenTalk signup verification code",
    text: `Hello ${name || "there"},\n\nYour ZenTalk verification code is ${otp}.\n\nThis code will expire in 10 minutes.\n\nIf you did not request this, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827"><h2>Verify your ZenTalk account</h2><p>Hello ${name || "there"},</p><p>Your verification code is:</p><div style="margin:18px 0;font-size:28px;font-weight:700;letter-spacing:.3em;color:#0f766e">${otp}</div><p>This code will expire in 10 minutes.</p><p>If you did not request this, you can ignore this email.</p></div>`,
  });
}

export async function sendExpiryMail(email, group) {
  const backendUrl = getBackendPublicUrl();
  return sendMail({
    to: email,
    subject: "ZenTalk Group Expiry Warning",
    text: `Your group "${group.name}" is expiring soon. Expiry date: ${new Date(group.expiryDate).toLocaleString()}.`,
    html: `<h2>Your group "${group.name}" is expiring soon</h2><p>Expiry Date: ${new Date(group.expiryDate).toLocaleString()}</p><p>Take action:</p>${backendUrl ? `<a href="${backendUrl}/extend/${group._id}">Extend</a><br/><br/><a href="${backendUrl}/delete/${group._id}">Delete</a><br/><br/><a href="${backendUrl}/retrieve/${group._id}">Delete &amp; Retrieve</a>` : "<p>Contact support to manage this group.</p>"}`,
  });
}

export async function sendPasswordResetEmail({ to, name, resetToken }) {
  const frontendUrl = getFrontendPublicUrl();
  const resetUrl = frontendUrl
    ? `${frontendUrl}/reset/${encodeURIComponent(resetToken)}`
    : "";
  return sendMail({
    to,
    subject: "ZenTalk password reset",
    text: `Hello ${name || "there"},\n\nYou requested a password reset for your ZenTalk account.\n\n${resetUrl ? `Click this link to reset your password: ${resetUrl}` : "Open ZenTalk to reset your password."}\n\nThis link will expire in 1 hour.\n\nIf you did not request this, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827"><h2>Reset your ZenTalk password</h2><p>Hello ${name || "there"},</p><p>You requested a password reset for your ZenTalk account.</p>${resetUrl ? `<p><a href="${resetUrl}">Reset Password</a></p>` : "<p>Open ZenTalk to reset your password.</p>"}<p>This link will expire in 1 hour.</p><p>If you did not request this, you can ignore this email.</p></div>`,
  });
}
