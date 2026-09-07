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

  // If SMTP_* vars are set, use them
  if (host && user && pass) {
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

  // Fallback to Gmail if EMAIL and APP_PASSWORD are set
  const gmailUser = process.env.EMAIL;
  const gmailPass = process.env.APP_PASSWORD;
  if (gmailUser && gmailPass) {
    return {
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: gmailUser,
    pass: gmailPass,
  },
};
  }

  return null;
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
  if (!transporter) {
    return { ok: false, reason: "SMTP is not configured." };
  }

  try {
    await transporter.verify();
    return { ok: true };
  } catch (error) {
    console.error("SMTP VERIFY ERROR:", error);
    return {
      ok: false,
      reason: `${error.code || "SMTP_ERROR"}: ${error.message}`,
    };
  }
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
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      reason: "RESEND_API_KEY is not configured.",
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "ZenTalk <onboarding@resend.dev>",
      to: [to],
      subject: "ZenTalk signup verification code",
      text: `Hello ${name || "there"},

Your ZenTalk verification code is ${otp}.

This code will expire in 10 minutes.

If you did not request this, you can ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
          <h2>Verify your ZenTalk account</h2>
          <p>Hello ${name || "there"},</p>
          <p>Your verification code is:</p>
          <div style="margin: 18px 0; font-size: 28px; font-weight: 700; letter-spacing: 0.3em; color: #0f766e;">
            ${otp}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you did not request this, you can ignore this email.</p>
        </div>
      `,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("RESEND ERROR:", data);

    const error = new Error(
      data?.message || "Failed to send email through Resend."
    );
    error.statusCode = response.status;
    throw error;
  }

  return {
    ok: true,
    id: data.id,
  };
}

export const sendExpiryMail = async (email, group) => {
  const transporter = await getMailer();
  if (!transporter) return { ok: false, reason: "SMTP is not configured." };

  await transporter.sendMail({
    from: buildFromAddress(),
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

  return { ok: true };
};

export async function sendPasswordResetEmail({ to, name, resetToken }) {
  const transporter = await getMailer();
  if (!transporter) return { ok: false, reason: "SMTP is not configured." };

  const resetUrl = `http://localhost:5173/reset/${resetToken}`;

  await transporter.sendMail({
    from: buildFromAddress(),
    to,
    subject: "ZenTalk password reset",
    text: `Hello ${name},\n\nYou requested a password reset for your ZenTalk account.\n\nClick this link to reset your password: ${resetUrl}\n\nThis link will expire in 1 hour.\n\nIf you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2 style="margin-bottom: 12px;">Reset your ZenTalk password</h2>
        <p>Hello ${name},</p>
        <p>You requested a password reset for your ZenTalk account.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background-color: #0f766e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
        </p>
        <p>Or copy and paste this link: <a href="${resetUrl}">${resetUrl}</a></p>
        <p>This link will expire in 1 hour.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });

  return { ok: true };
}
