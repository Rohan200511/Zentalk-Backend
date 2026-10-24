import dotenv from "dotenv";
dotenv.config();
import nodemailer from "nodemailer";

let transporterPromise = null;

function getGmailConfig() {
  const user = process.env.EMAIL?.trim();
  const pass = process.env.APP_PASSWORD?.replace(/\s+/g, "");

  if (!user || !pass) return null;

  return {
    service: "gmail",
    auth: { user, pass },
  };
}

export async function getMailer() {
  const config = getGmailConfig();
  if (!config) return null;
  if (!transporterPromise) {
    transporterPromise = Promise.resolve(nodemailer.createTransport(config));
  }
  return transporterPromise;
}

export async function verifyMailer() {
  const transporter = await getMailer();
  if (!transporter) {
    return { ok: false, reason: "Gmail is not configured. Set EMAIL and APP_PASSWORD." };
  }

  try {
    await transporter.verify();
    return { ok: true };
  } catch (error) {
    console.error("GMAIL VERIFY ERROR:", error);
    return {
      ok: false,
      reason: `${error.code || "GMAIL_ERROR"}: ${error.message}`,
    };
  }
}

function buildFromAddress() {
  // Gmail requires the sender to match the authenticated Gmail account.
  return process.env.EMAIL?.trim() || "";
}

function getBackendPublicUrl() {
  return (process.env.BACKEND_PUBLIC_URL || "https://zentalk-backend.onrender.com").replace(/\/$/, "");
}

function getFrontendPublicUrl() {
  return (process.env.FRONTEND_PUBLIC_URL || "https://zen-talk-zeta.vercel.app").replace(/\/$/, "");
}

async function sendMail(message) {
  const transporter = await getMailer();
  if (!transporter) {
    return { ok: false, reason: "Gmail is not configured. Set EMAIL and APP_PASSWORD." };
  }

  await transporter.sendMail({ from: buildFromAddress(), ...message });
  return { ok: true };
}

export async function sendLoginAlert({ to, name, username }) {
  return sendMail({
    to,
    subject: "ZenTalk login alert",
    text: `Hello ${name || username},\n\nYour ZenTalk account was just signed in successfully.\n\nUsername: ${username}\nTime: ${new Date().toISOString()}\n\nIf this was not you, please change your password immediately.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2>ZenTalk login alert</h2>
        <p>Hello ${name || username},</p>
        <p>Your ZenTalk account was just signed in successfully.</p>
        <p><strong>Username:</strong> ${username}</p>
        <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        <p>If this was not you, please change your password immediately.</p>
      </div>
    `,
  });
}

export async function sendWelcomeEmail({ to, name, username }) {
  return sendMail({
    to,
    subject: "Welcome to ZenTalk",
    text: `Hello ${name || username},\n\nWelcome to ZenTalk. Your account is now ready.\n\nUsername: ${username}\n\nYou can now sign in and start chatting in real time.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2>Welcome to ZenTalk</h2>
        <p>Hello ${name || username},</p>
        <p>Your ZenTalk account is now ready.</p>
        <p><strong>Username:</strong> ${username}</p>
        <p>You can now sign in and start chatting in real time.</p>
      </div>
    `,
  });
}

export async function sendSignupOtpEmail({ to, name, otp }) {
  return sendMail({
    to,
    subject: "ZenTalk signup verification code",
    text: `Hello ${name || "there"},\n\nYour ZenTalk verification code is ${otp}.\n\nThis code will expire in 10 minutes.\n\nIf you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2>Verify your ZenTalk account</h2>
        <p>Hello ${name || "there"},</p>
        <p>Your verification code is:</p>
        <div style="margin: 18px 0; font-size: 28px; font-weight: 700; letter-spacing: 0.3em; color: #0f766e;">${otp}</div>
        <p>This code will expire in 10 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });
}

export async function sendExpiryMail(email, group) {
  return sendMail({
    to: email,
    subject: "ZenTalk Group Expiry Warning",
    text: `Your group \"${group.name}\" is expiring soon. Expiry date: ${new Date(group.expiryDate).toLocaleString()}.`,
    html: `
      <h2>Your group "${group.name}" is expiring soon</h2>
      <p>Expiry Date: ${new Date(group.expiryDate).toLocaleString()}</p>
      <p>Take action:</p>
      <a href="${getBackendPublicUrl()}/extend/${group._id}">Extend</a><br/><br/>
      <a href="${getBackendPublicUrl()}/delete/${group._id}">Delete</a><br/><br/>
      <a href="${getBackendPublicUrl()}/retrieve/${group._id}">Delete &amp; Retrieve</a>
    `,
  });
}

export async function sendPasswordResetEmail({ to, name, resetToken }) {
  const resetUrl = `${getFrontendPublicUrl()}/reset/${encodeURIComponent(resetToken)}`;

  return sendMail({
    to,
    subject: "ZenTalk password reset",
    text: `Hello ${name || "there"},\n\nYou requested a password reset for your ZenTalk account.\n\nClick this link to reset your password: ${resetUrl}\n\nThis link will expire in 1 hour.\n\nIf you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2>Reset your ZenTalk password</h2>
        <p>Hello ${name || "there"},</p>
        <p>You requested a password reset for your ZenTalk account.</p>
        <p><a href="${resetUrl}">Reset Password</a></p>
        <p>This link will expire in 1 hour.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });
}
