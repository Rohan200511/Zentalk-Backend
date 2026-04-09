import dotenv from "dotenv";
dotenv.config();
import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL,
    pass: process.env.APP_PASSWORD
  }
});

function getSmtpConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || "false") === "true";

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  };
}

let transporterPromise = null;

export async function getMailer() {
  const smtpConfig = getSmtpConfig();
  if (!smtpConfig) return null;
  if (transporterPromise) return transporterPromise;

  transporterPromise = Promise.resolve(nodemailer.createTransport(smtpConfig));
  return transporterPromise;
}

export async function verifyMailer() {
  const transporter = await getMailer();
  if (!transporter) return { ok: false, reason: "SMTP is not configured." };
  await transporter.verify();
  return { ok: true };
}

function buildFromAddress() {
  return (
    process.env.SMTP_FROM || process.env.SMTP_USER || "no-reply@zentalk.app"
  );
}

export async function sendLoginAlert({ to, name, username }) {
  const transporter = await getMailer();
  if (!transporter) return { ok: false, reason: "SMTP is not configured." };

  await transporter.sendMail({
    from: buildFromAddress(),
    to,
    subject: "ZenTalk login alert",
    text: `Hello ${name || username},\n\nYour ZenTalk account was just signed in successfully.\n\nUsername: ${username}\nTime: ${new Date().toISOString()}\n\nIf this was not you, please change your password immediately.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2 style="margin-bottom: 12px;">ZenTalk login alert</h2>
        <p>Hello ${name || username},</p>
        <p>Your ZenTalk account was just signed in successfully.</p>
        <p><strong>Username:</strong> ${username}</p>
        <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        <p>If this was not you, please change your password immediately.</p>
      </div>
    `,
  });

  return { ok: true };
}

export async function sendWelcomeEmail({ to, name, username }) {
  const transporter = await getMailer();
  if (!transporter) return { ok: false, reason: "SMTP is not configured." };

  await transporter.sendMail({
    from: buildFromAddress(),
    to,
    subject: "Welcome to ZenTalk",
    text: `Hello ${name || username},\n\nWelcome to ZenTalk. Your account is now ready.\n\nUsername: ${username}\n\nYou can now sign in and start chatting in real time.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2 style="margin-bottom: 12px;">Welcome to ZenTalk</h2>
        <p>Hello ${name || username},</p>
        <p>Your ZenTalk account is now ready.</p>
        <p><strong>Username:</strong> ${username}</p>
        <p>You can now sign in and start chatting in real time.</p>
      </div>
    `,
  });

  return { ok: true };
}

export async function sendSignupOtpEmail({ to, name, otp }) {
  const transporter = await getMailer();
  if (!transporter) return { ok: false, reason: "SMTP is not configured." };

  await transporter.sendMail({
    from: buildFromAddress(),
    to,
    subject: "ZenTalk signup verification code",
    text: `Hello ${name || "there"},\n\nYour ZenTalk verification code is ${otp}.\n\nThis code will expire in 10 minutes.\n\nIf you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2 style="margin-bottom: 12px;">Verify your ZenTalk account</h2>
        <p>Hello ${name || "there"},</p>
        <p>Your verification code is:</p>
        <div style="margin: 18px 0; font-size: 28px; font-weight: 700; letter-spacing: 0.3em; color: #0f766e;">${otp}</div>
        <p>This code will expire in 10 minutes.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });

  return { ok: true };
}

export const sendExpiryMail = async (email, group) => {
  await transporter.sendMail({
    to: email,
    subject: "⚠️ ZenTalk Group Expiry Warning",
    html: `
      <h2>Your group "${group.name}" is expiring soon</h2>
      <p>Expiry Date: ${new Date(group.expiryDate).toLocaleString()}</p>

      <p>Take action:</p>

      <a href="http://localhost:3001/extend/${group._id}">Extend</a><br/><br/>
      <a href="http://localhost:3001/delete/${group._id}">Delete</a><br/><br/>
      <a href="http://localhost:3001/retrieve/${group._id}">Delete & Retrieve</a>
    `
  });
};
