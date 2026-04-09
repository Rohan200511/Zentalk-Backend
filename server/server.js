import express from 'express';
import bcrypt from 'bcryptjs';
import { createServer } from 'node:http';
import { isValidObjectId, Types } from 'mongoose';
import { Server } from 'socket.io';
import { Call } from './models.js';

import { connectToDatabase } from './db.js';
import { sendLoginAlert, sendSignupOtpEmail, sendWelcomeEmail, verifyMailer, sendExpiryMail } from './mailer.js';
import { Chat, ChatPreference, Message, SignupOtp, User, Group } from './models.js';

import cron from "node-cron";

const PORT = Number(process.env.PORT || 3001);

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const userSockets = new Map();
const socketUsers = new Map();
const callRooms = new Map();
const SIGNUP_OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function getSocketSet(userId) {
  if (!userSockets.has(userId)) {
    userSockets.set(userId, new Set());
  }
  return userSockets.get(userId);
}

function emitToUser(userId, event, payload) {
  const sockets = userSockets.get(userId);
  if (!sockets || sockets.size === 0) return false;
  sockets.forEach(socketId => io.to(socketId).emit(event, payload));
  return true;
}

function getOrCreateRoom(callId, callerId, chatId, participantIds = []) {
  if (!callRooms.has(callId)) {
    callRooms.set(callId, {
      callId,
      chatId,
      callerId,
      participants: new Set([callerId]),
      invitedUsers: new Set(participantIds),
    });
  }
  return callRooms.get(callId);
}

function removeSocket(socketId) {
  const userId = socketUsers.get(socketId);
  if (!userId) return;

  const sockets = userSockets.get(userId);
  if (sockets) {
    sockets.delete(socketId);
    if (sockets.size === 0) userSockets.delete(userId);
  }

  socketUsers.delete(socketId);
}

function leaveRoom(callId, userId, { endRoom = false } = {}) {
  const room = callRooms.get(callId);
  if (!room) return;

  if (endRoom) {
    room.participants.forEach(participantId => {
      if (participantId !== userId) {
        emitToUser(participantId, 'call-ended', { callId, fromUserId: userId });
      }
    });
    callRooms.delete(callId);
    return;
  }

  if (room.participants.has(userId)) {
    room.participants.delete(userId);
    room.participants.forEach(participantId => {
      emitToUser(participantId, 'participant-left', { callId, userId });
    });
  }

  if (room.participants.size === 0) {
    callRooms.delete(callId);
  }
}

function serializeUser(user) {
  return {
    id: user._id.toString(),
    name: user.name || '',
    username: user.username || '',
    email: user.email || '',
    mobile: user.mobile || '',
    avatar: user.avatar || '🧑',
    bio: user.bio || '',
    blockedUserIds: (user.blockedUserIds || []).map(id => id.toString()),
    contactUserIds: (user.contactUserIds || []).map(id => id.toString()),
    status: user.status || 'offline',
    lastSeen: new Date(user.lastSeen || Date.now()).getTime(),
    createdAt: new Date(user.createdAt || Date.now()).getTime(),
  };
}

function serializeMessage(message) {
  const chatId = message.chatId
    ? message.chatId.toString()
    : message.groupId
      ? `chat-group-${message.groupId.toString()}`
      : '';

  return {
    id: message._id.toString(),
    chatId,
    senderId: message.senderId.toString(),
    text: message.text || '',
    type: message.type || 'text',
    mediaUrl: message.mediaUrl || undefined,
    fileName: message.fileName || undefined,
    fileSize: message.fileSize || undefined,
    status: message.status || 'delivered',
    timestamp: new Date(message.timestamp || Date.now()).getTime(),
    replyTo: message.replyTo ? message.replyTo.toString() : undefined,
    forwarded: Boolean(message.forwarded),
    edited: Boolean(message.edited),
    editedAt: message.editedAt ? new Date(message.editedAt).getTime() : undefined,
    deletedFor: (message.deletedFor || []).map(id => id.toString()),
    starred: Boolean(message.starred),
    reactions: Object.fromEntries(
      message.reactions && typeof message.reactions.entries === 'function'
        ? Array.from(message.reactions.entries())
        : Object.entries(message.reactions || {}),
    ),
    disappearsAt: message.disappearsAt ? new Date(message.disappearsAt).getTime() : undefined,
  };
}

function serializeChat(chat, currentUserId, usersById, preference = null) {
  if (chat.type === 'group') {
    const participantIds = (chat.participantIds || []).map(id => id.toString());
    return {
      id: chat._id.toString(),
      type: 'group',
      name: chat.name || 'Group Chat',
      avatar: chat.avatar || '👥',
      participants: participantIds,
      groupId: chat.groupId || '',
      lastMessage: chat.lastMessage || '',
      lastTime: new Date(chat.lastTime || chat.createdAt || Date.now()).getTime(),
      unreadCount: 0,
      pinned: false,
      muted: false,
      archived: false,
      wallpaper: '',
      disappearing: 'off',
    };
  }

  const participantIds = (chat.participantIds || []).map(id => id.toString());
  const otherUserId = participantIds.find(id => id !== currentUserId) || participantIds[0] || '';
  const otherUser = usersById.get(otherUserId);

  return {
    id: chat._id.toString(),
    type: 'dm',
    name: otherUser?.name || 'Direct Message',
    avatar: otherUser?.avatar || '🧑',
    participants: participantIds,
    lastMessage: chat.lastMessage || '',
    lastTime: new Date(chat.lastTime || chat.createdAt || Date.now()).getTime(),
    unreadCount: 0,
    pinned: Boolean(preference?.pinned),
    muted: Boolean(preference?.muted),
    archived: Boolean(preference?.archived),
    wallpaper: '',
    disappearing: chat.disappearing || 'off',
  };
}

function getDisappearDuration(timer) {
  switch (timer) {
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '90d':
      return 90 * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

function buildPreferenceMap(preferences) {
  return new Map(preferences.map(preference => [preference.chatId.toString(), preference]));
}

function getMessagePreview(message) {
  if (!message) return '';
  if (message.text) return message.text;
  if (message.type === 'audio') return 'Voice message';
  if (message.type === 'image') return 'Image';
  if (message.type === 'video') return 'Video';
  if (message.type === 'document') return 'Attachment';
  return 'Message';
}

async function getOrCreateChatPreference(chatId, userId) {
  let preference = await ChatPreference.findOne({ chatId, userId });
  if (!preference) {
    preference = await ChatPreference.create({ chatId, userId });
  }
  return preference;
}

async function recalculateChatSummary(chatId) {
  const latestMessage = await Message.findOne({ chatId }).sort({ timestamp: -1 });
  if (!latestMessage) {
    await Chat.findByIdAndUpdate(chatId, {
      lastMessage: '',
      lastTime: new Date(),
    });
    return;
  }

  const fallbackText = latestMessage.type === 'audio'
    ? 'Voice message'
    : latestMessage.type === 'image'
      ? 'Image'
      : latestMessage.type === 'video'
        ? 'Video'
        : latestMessage.type === 'document'
          ? 'Attachment'
          : 'Message';

  await Chat.findByIdAndUpdate(chatId, {
    lastMessage: latestMessage.text || fallbackText,
    lastTime: latestMessage.timestamp || new Date(),
  });
}

async function comparePassword(inputPassword, storedPassword) {
  if (!storedPassword) return false;
  if (storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$') || storedPassword.startsWith('$2y$')) {
    return bcrypt.compare(inputPassword, storedPassword);
  }
  return inputPassword === storedPassword;
}

function escapeForRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function generateOtpCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function normalizeMobile(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidMobile(value) {
  const digits = normalizeMobile(value);
  return digits.length >= 10 && digits.length <= 15;
}

async function findOrCreateDirectChat(userIdA, userIdB) {
  const participantIds = [userIdA, userIdB].sort();
  let chat = await Chat.findOne({
    type: 'dm',
    participantIds: { $all: participantIds, $size: 2 },
  });

  if (!chat) {
    chat = await Chat.create({
      type: 'dm',
      participantIds: participantIds.map(id => new Types.ObjectId(id)),
      lastMessage: '',
      lastTime: new Date(),
      createdAt: new Date(),
    });
  }

  return chat;
}

async function buildBootstrap(userId) {
  await connectToDatabase();

  const expiredMessages = await Message.find({ disappearsAt: { $lte: new Date() } }, { chatId: 1 });
  if (expiredMessages.length > 0) {
    await Message.deleteMany({ _id: { $in: expiredMessages.map(message => message._id) } });
    for (const chatId of new Set(expiredMessages.map(message => message.chatId.toString()))) {
      await recalculateChatSummary(chatId);
    }
  }

  const users = await User.find({}).sort({ createdAt: 1 });
  const usersById = new Map(users.map(user => [user._id.toString(), user]));
  const currentUser = usersById.get(userId);
  if (!currentUser) {
    throw new Error('User not found.');
  }

  const otherUsers = users.filter(user => user._id.toString() !== userId);
  const contactUserIds = new Set((currentUser.contactUserIds || []).map(id => id.toString()));
  const chats = [];
  const messagesByChat = {};

  for (const otherUser of otherUsers) {
    const chat = await findOrCreateDirectChat(userId, otherUser._id.toString());
    chats.push(chat);
  }

  const chatIds = chats.map(chat => chat._id);
  const preferences = chatIds.length > 0
    ? await ChatPreference.find({
        userId: new Types.ObjectId(userId),
        chatId: { $in: chatIds },
      })
    : [];
  const preferenceMap = buildPreferenceMap(preferences);
  const rawMessages = chatIds.length > 0
    ? await Message.find({
        chatId: { $in: chatIds },
        $or: [
          { disappearsAt: null },
          { disappearsAt: { $gt: new Date() } },
        ],
      }).sort({ timestamp: 1 })
    : [];

  rawMessages.forEach(message => {
    const chatId = message.chatId.toString();
    if ((message.deletedFor || []).some(id => id.toString() === userId)) return;

    const preference = preferenceMap.get(chatId);
    if (preference?.clearBefore && new Date(message.timestamp).getTime() <= new Date(preference.clearBefore).getTime()) {
      return;
    }

    if (!messagesByChat[chatId]) messagesByChat[chatId] = [];
    messagesByChat[chatId].push(serializeMessage(message));
  });

  const groups = await Group.find({
    "members.userId": new Types.ObjectId(userId),
  });

  const groupChats = groups.map((group) => {
    const participantIds = (group.members || []).map((member) => member.userId.toString());
    return {
      _id: `chat-group-${group._id.toString()}`,
      type: 'group',
      name: group.name,
      avatar: '👥',
      participants: participantIds,
      groupId: group._id.toString(),
      lastMessage: 'Group created',
      lastTime: group.createdAt || new Date(),
      createdAt: group.createdAt || new Date(),
    };
  });

  const allChats = [...chats, ...groupChats];

  const chatsWithPreview = allChats
    .sort((a, b) => new Date(b.lastTime || b.createdAt).getTime() - new Date(a.lastTime || a.createdAt).getTime())
    .map(chat => {
      const preference = preferenceMap.get(chat._id.toString()) || null;
      const serialized = serializeChat(chat, userId, usersById, preference);
      const visibleMessages = messagesByChat[chat._id.toString()] || [];
      const latestVisibleMessage = visibleMessages[visibleMessages.length - 1];
      return {
        ...serialized,
        lastMessage: latestVisibleMessage ? getMessagePreview(latestVisibleMessage) : '',
        lastTime: latestVisibleMessage?.timestamp ?? serialized.lastTime,
      };
    });

  return {
    currentUser: serializeUser(currentUser),
    users: users.map(serializeUser),
    chats: chatsWithPreview,
    messagesByChat,
    groups: groups.map(g => ({
      id: g._id.toString(),
      name: g.name,
      ownerEmail: g.ownerEmail,
      isTemporary: g.isTemporary,
      expiryDate: g.expiryDate,
      members: g.members,
      createdAt: g.createdAt,
    })),
    communities: [],
    contacts: otherUsers.filter(otherUser => contactUserIds.has(otherUser._id.toString())).map(otherUser => ({
      id: `contact-${otherUser._id.toString()}`,
      name: otherUser.name || '',
      username: otherUser.username || '',
      userId: otherUser._id.toString(),
      addedAt: new Date(otherUser.createdAt || Date.now()).getTime(),
    })),
  };
}

function ensureObjectId(value, fieldName) {
  if (!isValidObjectId(value)) {
    const error = new Error(`Invalid ${fieldName}.`);
    error.statusCode = 400;
    throw error;
  }
  return new Types.ObjectId(value);
}

app.get('/health', async (_req, res) => {
  try {
    await connectToDatabase();
    res.json({ ok: true, port: PORT, mongo: 'connected' });
  } catch (error) {
    res.status(500).json({ ok: false, port: PORT, mongo: 'error', message: error.message });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await connectToDatabase();
    res.json({ ok: true, mongo: 'connected' });
  } catch (error) {
    res.status(500).json({ ok: false, mongo: 'error', message: error.message });
  }
});

app.get('/api/smtp/health', async (_req, res) => {
  try {
    const result = await verifyMailer();
    if (!result.ok) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, reason: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    await connectToDatabase();
    const { emailOrUsername, password } = req.body || {};
    const normalizedLogin = String(emailOrUsername || '').trim();
    const escapedLogin = escapeForRegex(normalizedLogin);
    const user = await User.findOne({
      $or: [
        { email: new RegExp(`^${escapedLogin}$`, 'i') },
        { username: new RegExp(`^${escapedLogin}$`, 'i') },
      ],
    });

    if (!user || !(await comparePassword(password, user.password))) {
      res.status(401).json({ ok: false, message: 'Invalid credentials.' });
      return;
    }

    user.status = 'online';
    user.lastSeen = new Date();
    await user.save();

    const loginMailResult = await sendLoginAlert({
      to: user.email,
      name: user.name,
      username: user.username,
    }).catch(error => ({ ok: false, reason: error.message }));

    const bootstrap = await buildBootstrap(user._id.toString());
    res.json({ ok: true, ...bootstrap, mail: loginMailResult });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

app.post('/api/auth/signup/request-otp', async (req, res) => {
  try {
    await connectToDatabase();
    const { name, username, email, mobile, password, avatar } = req.body || {};
    if (!name || !username || !email || !mobile || !password) {
      res.status(400).json({ ok: false, message: 'Missing required fields.' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ ok: false, message: 'Password must be at least 6 characters.' });
      return;
    }
    if (!isValidEmail(email)) {
      res.status(400).json({ ok: false, message: 'Enter a valid email address.' });
      return;
    }
    if (!isValidMobile(mobile)) {
      res.status(400).json({ ok: false, message: 'Enter a valid mobile number with 10 to 15 digits.' });
      return;
    }

    const smtpCheck = await verifyMailer();
    if (!smtpCheck.ok) {
      res.status(400).json({ ok: false, message: smtpCheck.reason || 'SMTP is not configured.' });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const normalizedUsername = String(username).trim();
    const normalizedMobile = normalizeMobile(mobile);
    const emailRegex = new RegExp(`^${escapeForRegex(normalizedEmail)}$`, 'i');
    const usernameRegex = new RegExp(`^${escapeForRegex(normalizedUsername)}$`, 'i');

    const existing = await User.findOne({
      $or: [{ email: emailRegex }, { username: usernameRegex }, { mobile: normalizedMobile }],
    });
    if (existing) {
      res.status(409).json({ ok: false, message: 'Email, username, or mobile number is already taken.' });
      return;
    }

    await SignupOtp.deleteMany({
      $or: [{ email: emailRegex }, { username: usernameRegex }],
    });

    const otp = generateOtpCode();
    const otpHash = await bcrypt.hash(otp, 10);
    const hashedPassword = await bcrypt.hash(password, 10);
    const request = await SignupOtp.create({
      name,
      username: normalizedUsername,
      email: normalizedEmail,
      mobile: normalizedMobile,
      passwordHash: hashedPassword,
      avatar: avatar || '🧑',
      otpHash,
      expiresAt: new Date(Date.now() + SIGNUP_OTP_TTL_MS),
      createdAt: new Date(),
    });

    await sendSignupOtpEmail({
      to: normalizedEmail,
      name,
      otp,
    });

    res.status(201).json({
      ok: true,
      requestId: request._id.toString(),
      message: `Verification code sent to ${normalizedEmail}.`,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

app.post('/api/auth/signup/verify-otp', async (req, res) => {
  try {
    await connectToDatabase();
    const { requestId, otp } = req.body || {};
    if (!isValidObjectId(requestId) || !otp) {
      res.status(400).json({ ok: false, message: 'Invalid verification request.' });
      return;
    }

    const request = await SignupOtp.findById(requestId);
    if (!request) {
      res.status(404).json({ ok: false, message: 'Verification request not found. Please request a new code.' });
      return;
    }

    if (new Date(request.expiresAt).getTime() < Date.now()) {
      await SignupOtp.findByIdAndDelete(requestId);
      res.status(410).json({ ok: false, message: 'This verification code has expired. Please request a new one.' });
      return;
    }

    const validOtp = await bcrypt.compare(String(otp).trim(), request.otpHash);
    if (!validOtp) {
      request.attempts = Number(request.attempts || 0) + 1;
      if (request.attempts >= MAX_OTP_ATTEMPTS) {
        await SignupOtp.findByIdAndDelete(requestId);
        res.status(429).json({ ok: false, message: 'Too many incorrect attempts. Please request a new code.' });
        return;
      }
      await request.save();
      res.status(401).json({ ok: false, message: 'Incorrect verification code.' });
      return;
    }

    const existing = await User.findOne({
      $or: [
        { email: new RegExp(`^${escapeForRegex(request.email)}$`, 'i') },
        { username: new RegExp(`^${escapeForRegex(request.username)}$`, 'i') },
        { mobile: request.mobile },
      ],
    });
    if (existing) {
      await SignupOtp.findByIdAndDelete(requestId);
      res.status(409).json({ ok: false, message: 'Email, username, or mobile number is already taken.' });
      return;
    }

    const user = await User.create({
      name: request.name,
      username: request.username,
      email: request.email,
      mobile: request.mobile || '',
      password: request.passwordHash,
      avatar: request.avatar || '🧑',
      bio: 'Hey there! I am using ZenTalk.',
      blockedUserIds: [],
      contactUserIds: [],
      status: 'online',
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await SignupOtp.findByIdAndDelete(requestId);

    const welcomeMailResult = await sendWelcomeEmail({
      to: user.email,
      name: user.name,
      username: user.username,
    }).catch(error => ({ ok: false, reason: error.message }));

    const bootstrap = await buildBootstrap(user._id.toString());
    res.status(201).json({ ok: true, ...bootstrap, mail: welcomeMailResult, message: 'Email verified successfully.' });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    await connectToDatabase();
    const { userId } = req.body || {};
    if (isValidObjectId(userId)) {
      await User.findByIdAndUpdate(userId, { status: 'offline', lastSeen: new Date() });
    }
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/contacts', async (req, res) => {
  try {
    await connectToDatabase();
    const { ownerUserId, targetUserId } = req.body || {};
    const ownerId = ensureObjectId(ownerUserId, 'ownerUserId');
    const targetId = ensureObjectId(targetUserId, 'targetUserId');

    if (ownerId.toString() === targetId.toString()) {
      res.status(400).json({ ok: false, message: 'You cannot add yourself.' });
      return;
    }

    const [owner, target] = await Promise.all([
      User.findById(ownerId),
      User.findById(targetId),
    ]);

    if (!owner || !target) {
      res.status(404).json({ ok: false, message: 'User not found.' });
      return;
    }

    const nextContactUserIds = Array.from(
      new Set([...(owner.contactUserIds || []).map(id => id.toString()), targetId.toString()]),
    ).map(id => new Types.ObjectId(id));
    owner.contactUserIds = nextContactUserIds;
    await owner.save();

    const chat = await findOrCreateDirectChat(ownerId.toString(), targetId.toString());
    const users = await User.find({ _id: { $in: chat.participantIds } });
    const usersById = new Map(users.map(user => [user._id.toString(), user]));

    res.status(201).json({
      ok: true,
      contact: {
        id: `contact-${target._id.toString()}`,
        name: target.name || '',
        username: target.username || '',
        userId: target._id.toString(),
        addedAt: Date.now(),
      },
      chat: serializeChat(chat, ownerId.toString(), usersById),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

app.get('/api/bootstrap/:userId', async (req, res) => {
  try {
    const bootstrap = await buildBootstrap(req.params.userId);
    res.json({ ok: true, ...bootstrap });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

app.patch('/api/users/:userId', async (req, res) => {
  try {
    await connectToDatabase();
    const allowedFields = ['name', 'mobile', 'avatar', 'bio', 'status', 'blockedUserIds'];
    const updates = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => allowedFields.includes(key)),
    );

    const user = await User.findByIdAndUpdate(req.params.userId, updates, { new: true });
    if (!user) {
      res.status(404).json({ ok: false, message: 'User not found.' });
      return;
    }

    res.json({ ok: true, user: serializeUser(user) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

app.patch('/api/chats/:chatId/settings', async (req, res) => {
  try {
    await connectToDatabase();
    const chatId = ensureObjectId(req.params.chatId, 'chatId');
    const userId = ensureObjectId(req.body?.userId, 'userId');
    const chat = await Chat.findById(chatId);
    if (!chat) {
      res.status(404).json({ ok: false, message: 'Chat not found.' });
      return;
    }

    if (!(chat.participantIds || []).some(id => id.toString() === userId.toString())) {
      res.status(403).json({ ok: false, message: 'You are not part of this chat.' });
      return;
    }

    const preferencePatch = {};
    if (typeof req.body?.muted === 'boolean') preferencePatch.muted = req.body.muted;
    if (typeof req.body?.archived === 'boolean') preferencePatch.archived = req.body.archived;
    if (typeof req.body?.pinned === 'boolean') preferencePatch.pinned = req.body.pinned;

    let preference = await getOrCreateChatPreference(chatId, userId);
    if (Object.keys(preferencePatch).length > 0) {
      Object.assign(preference, preferencePatch);
      await preference.save();
    }

    if (typeof req.body?.disappearing === 'string') {
      const nextTimer = req.body.disappearing;
      if (!['off', '24h', '7d', '90d'].includes(nextTimer)) {
        res.status(400).json({ ok: false, message: 'Invalid disappearing timer.' });
        return;
      }
      chat.disappearing = nextTimer;
      await chat.save();
    }

    const users = await User.find({ _id: { $in: chat.participantIds } });
    const usersById = new Map(users.map(user => [user._id.toString(), user]));
    const serializedChat = serializeChat(chat, userId.toString(), usersById, preference);

    if (typeof req.body?.disappearing === 'string') {
      for (const participantId of chat.participantIds || []) {
        const participantPreference = await getOrCreateChatPreference(chatId, participantId);
        emitToUser(participantId.toString(), 'chat-updated', {
          chat: serializeChat(chat, participantId.toString(), usersById, participantPreference),
        });
      }
    } else {
      emitToUser(userId.toString(), 'chat-updated', { chat: serializedChat });
    }

    res.json({ ok: true, chat: serializedChat });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

app.post('/api/chats/:chatId/clear', async (req, res) => {
  try {
    await connectToDatabase();
    const chatId = ensureObjectId(req.params.chatId, 'chatId');
    const userId = ensureObjectId(req.body?.userId, 'userId');
    const chat = await Chat.findById(chatId);
    if (!chat) {
      res.status(404).json({ ok: false, message: 'Chat not found.' });
      return;
    }

    if (!(chat.participantIds || []).some(id => id.toString() === userId.toString())) {
      res.status(403).json({ ok: false, message: 'You are not part of this chat.' });
      return;
    }

    const preference = await getOrCreateChatPreference(chatId, userId);
    preference.clearBefore = new Date();
    await preference.save();

    const users = await User.find({ _id: { $in: chat.participantIds } });
    const usersById = new Map(users.map(user => [user._id.toString(), user]));
    const serializedChat = {
      ...serializeChat(chat, userId.toString(), usersById, preference),
      lastMessage: '',
      lastTime: Date.now(),
    };

    emitToUser(userId.toString(), 'chat-cleared', {
      chatId: chatId.toString(),
      clearedAt: new Date(preference.clearBefore).getTime(),
    });
    emitToUser(userId.toString(), 'chat-updated', {
      chat: serializedChat,
    });

    res.json({
      ok: true,
      chatId: chatId.toString(),
      clearedAt: new Date(preference.clearBefore).getTime(),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

app.post('/api/messages/dm', async (req, res) => {
  try {
    await connectToDatabase();
    const {
      fromUserId,
      toUserId,
      text = '',
      replyTo = null,
      mediaUrl = '',
      type = 'text',
    } = req.body || {};

    const senderId = ensureObjectId(fromUserId, 'fromUserId');
    const recipientId = ensureObjectId(toUserId, 'toUserId');
    const [sender, recipient] = await Promise.all([
      User.findById(senderId),
      User.findById(recipientId),
    ]);

    if (!sender || !recipient) {
      res.status(404).json({ ok: false, message: 'User not found.' });
      return;
    }

    const senderBlocked = (sender.blockedUserIds || []).some(id => id.toString() === recipientId.toString());
    const recipientBlocked = (recipient.blockedUserIds || []).some(id => id.toString() === senderId.toString());
    if (senderBlocked || recipientBlocked) {
      res.status(403).json({ ok: false, message: 'You cannot message this user right now.' });
      return;
    }

    const chat = await findOrCreateDirectChat(senderId.toString(), recipientId.toString());
    const disappearDuration = getDisappearDuration(chat.disappearing || 'off');
    const timestamp = new Date();

    const message = await Message.create({
      chatId: chat._id,
      senderId,
      text,
      type,
      mediaUrl,
      status: 'delivered',
      timestamp,
      replyTo: replyTo && isValidObjectId(replyTo) ? new Types.ObjectId(replyTo) : null,
      forwarded: false,
      edited: false,
      deletedFor: [],
      starred: false,
      reactions: {},
      disappearsAt: disappearDuration > 0 ? new Date(timestamp.getTime() + disappearDuration) : null,
    });

    chat.lastMessage = text || (type === 'audio' ? 'Voice message' : type === 'image' ? 'Image' : 'Attachment');
    chat.lastTime = timestamp;
    await chat.save();

    const users = await User.find({ _id: { $in: chat.participantIds } });
    const usersById = new Map(users.map(user => [user._id.toString(), user]));
    const [senderPreference, recipientPreference] = await Promise.all([
      getOrCreateChatPreference(chat._id, senderId),
      getOrCreateChatPreference(chat._id, recipientId),
    ]);
    const serializedChatForSender = serializeChat(chat, senderId.toString(), usersById, senderPreference);
    const serializedChatForRecipient = serializeChat(chat, recipientId.toString(), usersById, recipientPreference);
    const serializedMessage = serializeMessage(message);

    emitToUser(senderId.toString(), 'message-created', {
      chat: serializedChatForSender,
      message: serializedMessage,
    });
    emitToUser(recipientId.toString(), 'message-created', {
      chat: serializedChatForRecipient,
      message: serializedMessage,
    });

    res.status(201).json({
      ok: true,
      chat: serializedChatForSender,
      message: serializedMessage,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ ok: false, message: error.message });
  }
});

cron.schedule('* * * * *', async () => {
  try {
    await connectToDatabase();
    const expiredMessages = await Message.find({ disappearsAt: { $lte: new Date() } }, { chatId: 1 });
    if (expiredMessages.length === 0) return;

    const affectedChatIds = Array.from(new Set(expiredMessages.map(message => message.chatId.toString())));
    await Message.deleteMany({ _id: { $in: expiredMessages.map(message => message._id) } });

    for (const chatId of affectedChatIds) {
      await recalculateChatSummary(chatId);
      const chat = await Chat.findById(chatId);
      if (!chat) continue;
      const users = await User.find({ _id: { $in: chat.participantIds } });
      const usersById = new Map(users.map(user => [user._id.toString(), user]));
      for (const participantId of chat.participantIds || []) {
        const preference = await getOrCreateChatPreference(chat._id, participantId);
        emitToUser(participantId.toString(), 'chat-updated', {
          chat: serializeChat(chat, participantId.toString(), usersById, preference),
        });
      }
    }
  } catch (error) {
    console.error('Failed to clean up expired messages:', error.message);
  }
});

io.on('connection', socket => {
  socket.on('register-user', ({ userId }) => {
    if (!userId) return;
    getSocketSet(userId).add(socket.id);
    socketUsers.set(socket.id, userId);
    socket.emit('registered', { userId, socketId: socket.id });
  });

  socket.on('call-user', async payload => {
    const { callId, fromUserId, chatId, targetUserIds } = payload;
    await connectToDatabase();

    const participants = await User.find({ _id: { $in: [fromUserId, ...targetUserIds] } });
    const usersById = new Map(participants.map(user => [user._id.toString(), user]));
    const caller = usersById.get(fromUserId);

    const blockedTarget = targetUserIds.find(targetUserId => {
      const target = usersById.get(targetUserId);
      const callerBlocked = (caller?.blockedUserIds || []).some(id => id.toString() === targetUserId);
      const targetBlocked = (target?.blockedUserIds || []).some(id => id.toString() === fromUserId);
      return callerBlocked || targetBlocked;
    });

    if (blockedTarget) {
      socket.emit('call-failed', {
        callId,
        message: 'This user is not available for calls.',
      });
      return;
    }

    await Call.create({
      callId,
      chatId,
      caller: fromUserId,
      participants: [fromUserId, ...targetUserIds],
      status: "ringing",
    });

    const room = getOrCreateRoom(callId, fromUserId, chatId, targetUserIds);

    let deliveredCount = 0;
    targetUserIds.forEach(targetUserId => {
      const delivered = emitToUser(targetUserId, 'incoming-call', payload);
      if (delivered) deliveredCount++;
    });

    if (deliveredCount === 0) {
      socket.emit('call-failed', {
        callId,
        message: 'User not online',
      });

      await Call.findOneAndUpdate(
        { callId },
        { status: "ended", endedAt: new Date() }
      );

      callRooms.delete(callId);
    }
  });

  socket.on('join-call', async payload => {
    const room = getOrCreateRoom(payload.callId, payload.fromUserId, payload.chatId);
    room.participants.add(payload.fromUserId);
    room.invitedUsers.delete(payload.fromUserId);

    room.participants.forEach(participantId => {
      if (participantId !== payload.fromUserId) {
        emitToUser(participantId, 'participant-joined', {
          callId: payload.callId,
          userId: payload.fromUserId,
        });
      }
    });

    await Call.findOneAndUpdate(
      { callId: payload.callId },
      { status: "accepted" }
    );

  });

  socket.on('webrtc-offer', payload => {
    emitToUser(payload.toUserId, 'webrtc-offer', payload);
  });

  socket.on('webrtc-answer', payload => {
    emitToUser(payload.toUserId, 'webrtc-answer', payload);
  });

  socket.on('ice-candidate', payload => {
    emitToUser(payload.toUserId, 'ice-candidate', payload);
  });

  socket.on('call-control', payload => {
    const room = callRooms.get(payload.callId);
    if (!room) return;
    room.participants.forEach(participantId => {
      if (participantId !== payload.fromUserId) {
        emitToUser(participantId, 'call-control-updated', payload);
      }
    });
  });

  socket.on('call-rejected', async payload => {
    const room = callRooms.get(payload.callId);
    if (!room) return;
    room.participants.forEach(participantId => {
      if (participantId !== payload.fromUserId) {
        emitToUser(participantId, 'call-rejected', payload);
      }
    });

    await Call.findOneAndUpdate(
      { callId: payload.callId },
      { status: "rejected", endedAt: new Date() }
    );

    room.invitedUsers.delete(payload.fromUserId);
  });

  socket.on('leave-call', payload => {
    leaveRoom(payload.callId, payload.fromUserId);
  });

  socket.on('call-ended', async payload => {
    await Call.findOneAndUpdate(
      { callId: payload.callId },
      { status: "ended", endedAt: new Date() }
    );

    leaveRoom(payload.callId, payload.fromUserId, { endRoom: true });
  });

  socket.on('disconnect', () => {
    const userId = socketUsers.get(socket.id);
    if (userId) {
      callRooms.forEach((room, callId) => {
        if (room.participants.has(userId) && !(userSockets.get(userId)?.size > 1)) {
          leaveRoom(callId, userId);
        }
      });
    }
    removeSocket(socket.id);
  });

  socket.on("join-group", ({ groupId }) => {
  socket.join(groupId);
});
});

httpServer.listen(PORT, async () => {
  try {
    await connectToDatabase();
    console.log(`ZenTalk realtime server listening on http://localhost:${PORT}`);
  } catch (error) {
    console.error('ZenTalk server started without Mongo connection:', error.message);
    console.log(`ZenTalk realtime server listening on http://localhost:${PORT}`);
  }
});


//-----------------------------Group Working Temprary - Rohan--------------------------------
app.post("/api/group/create", async (req, res) => {
  try {
    const { name, ownerEmail, duration, isTemporary, members } = req.body;

    const createdAt = new Date();
    let expiryDate = null;

    if (isTemporary) {
      if (duration === 0) {
        expiryDate = new Date(Date.now() + 60 * 1000);
      } else {
        expiryDate = new Date();
        expiryDate.setDate(createdAt.getDate() + duration);
      }
    }

    const group = await Group.create({
      name,
      ownerEmail,
      isTemporary,
      expiryDate,

      // 🔥 add members
      members: members || [],
    });

    res.json({ ok: true, group });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});


app.post("/api/group/extend/:id", async (req, res) => {
  const { duration } = req.body;

  const group = await Group.findById(req.params.id);

  group.expiryDate.setDate(group.expiryDate.getDate() + duration);
  group.status = "active";

  await group.save();

  res.json({ message: "Extended" });
});

app.post("/api/group/delete/:id", async (req, res) => {
  const group = await Group.findById(req.params.id);

  group.status = "deleted";
  await group.save();

  res.json({ message: "Group will be deleted soon" });

  io.to(group._id.toString()).emit("group-warning", {
  message: "⚠️ This group will be deleted soon. Save your files.",
  groupId: group._id
});
});

app.post("/api/group/retrieve/:id", async (req, res) => {
  const group = await Group.findById(req.params.id);

  // later we add zip logic
  await sendExpiryMail(group.ownerEmail, group);

  group.status = "deleted";
  await group.save();

  res.json({ message: "Data will be sent to email" });
});






cron.schedule("* * * * *", async () => {
  const now = new Date();

  const groups = await Group.find({ isTemporary: true });

  for (let group of groups) {
    const timeLeftMs = group.expiryDate - now;
    const daysLeft = timeLeftMs / (1000 * 60 * 60 * 24);

    // ---------------------------
    // 🔴 DEMO MODE (<= 2 min)
    // ---------------------------
    if (timeLeftMs <= 2 * 60 * 1000 && group.status !== "warning") {
      await sendExpiryMail(group.ownerEmail, group);

      group.status = "warning";
      await group.save();
    }

    // ---------------------------
    // 🟢 PRODUCTION MODE (7 days)
    // ---------------------------
    else if (daysLeft <= 7 && group.status !== "warning") {
      await sendExpiryMail(group.ownerEmail, group);

      group.status = "warning";
      await group.save();
    }

    // ---------------------------
    // 💀 DELETE LOGIC (COMMON)
    // ---------------------------
    if (timeLeftMs <= 0 && group.status === "warning") {

      io.to(group._id.toString()).emit("group-warning", {
        message: "💀 This group has been deleted.",
        groupId: group._id
      });

      await Group.deleteOne({ _id: group._id });
    }
  }
});


// EXTEND FROM EMAIL LINK
app.get("/extend/:id", async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).send("❌ Group not found");
    }

    // extend by 30 days (you can change)
    group.expiryDate.setDate(group.expiryDate.getDate() + 30);
    group.status = "active";

    await group.save();

    res.send("✅ Group extended successfully");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Server error");
  }
});

// DELETE FROM EMAIL
app.get("/delete/:id", async (req, res) => {
  const group = await Group.findById(req.params.id);

  if (!group) {
    return res.status(404).send("❌ Group not found or already deleted");
  }

  group.status = "deleted";
  await group.save();

  io.to(group._id.toString()).emit("group-warning", {
    message: "⚠️ This group will be deleted soon.",
    groupId: group._id
  });

  res.send("⚠️ Group will be deleted soon");
});

// RETRIEVE FROM EMAIL
app.get("/retrieve/:id", async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).send("❌ Group not found");
    }

    // 🔥 emit realtime warning
    io.to(group._id.toString()).emit("group-warning", {
      message: "📦 Data backup started. Group will be deleted soon.",
      groupId: group._id
    });

    // TODO: later zip logic

    group.status = "deleted";
    await group.save();

    res.send("📦 Data retrieval started");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Server error");
  }
});

app.post("/api/group/delete/:id", async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    group.status = "deleted";
    await group.save();

    // 🔥 realtime message
    io.to(group._id.toString()).emit("group-warning", {
      message: "⚠️ This group will be deleted soon. Save your files.",
      groupId: group._id
    });

    res.json({ message: "Group marked for deletion" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/api/calls/:userId', async (req, res) => {
  try {
    await connectToDatabase();

    const { userId } = req.params;

    const calls = await Call.find({
      participants: userId,
    })
      .sort({ createdAt: -1 })
      .populate('caller', 'name avatar')
      .populate('participants', 'name avatar');

    res.json({ ok: true, calls });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message });
  }
});

app.post("/api/group/extend/:id", async (req, res) => {
  try {
    const { duration } = req.body;

    const group = await Group.findById(req.params.id);

    if (!group) {
      return res.status(404).json({ error: "Group not found" });
    }

    group.expiryDate.setDate(group.expiryDate.getDate() + duration);
    group.status = "active";

    await group.save();

    res.json({ message: "Group extended successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/messages/group", async (req, res) => {
  try {
    const { groupId, senderId, text, replyTo = null, mediaUrl = '', type = 'text' } = req.body;

    const message = await Message.create({
      groupId: ensureObjectId(groupId, 'groupId'),
      senderId: ensureObjectId(senderId, 'senderId'),
      text,
      type,
      mediaUrl,
      replyTo: replyTo ? ensureObjectId(replyTo, 'replyTo') : null,
      timestamp: new Date(),
    });

    const serializedMessage = serializeMessage(message);
    io.to(groupId).emit("group-message", {
      groupId,
      message: serializedMessage,
    });

    res.json({ ok: true, message: serializedMessage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false });
  }
});

app.get("/api/messages/group/:groupId", async (req, res) => {
  try {
    const messages = await Message.find({
      groupId: ensureObjectId(req.params.groupId, 'groupId'),
    }).sort({ timestamp: 1 });

    res.json({ ok: true, messages: messages.map(serializeMessage) });
  } catch (err) {
    res.status(500).json({ ok: false });
  }
});