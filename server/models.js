import mongoose from 'mongoose';

export const Call = mongoose.model(
  "Call",
  new mongoose.Schema(
    {
      callId: { type: String, required: true, unique: true },
      chatId: { type: mongoose.Schema.Types.ObjectId, ref: "Chat" },
      caller: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      status: {
        type: String,
        enum: ["ringing", "accepted", "rejected", "ended"],
        default: "ringing",
      },
      startedAt: { type: Date, default: Date.now },
      endedAt: { type: Date },
    },
    { timestamps: true }
  )
);

const userSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  username: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, unique: true, index: true },
  mobile: { type: String, default: '' },
  password: { type: String, required: true },
  avatar: { type: String, default: '🧑' },
  bio: { type: String, default: 'Hey there! I am using ZenTalk.' },
  blockedUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: [] }],
  contactUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: [] }],
  status: { type: String, enum: ['online', 'offline', 'away'], default: 'offline' },
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'users',
  versionKey: false,
});

const chatSchema = new mongoose.Schema({
  type: { type: String, enum: ['dm'], default: 'dm', index: true },
  participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }],
  lastMessage: { type: String, default: '' },
  lastTime: { type: Date, default: Date.now },
  disappearing: { type: String, enum: ['off', '24h', '7d', '90d'], default: 'off' },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'chats',
  versionKey: false,
});

const chatPreferenceSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  pinned: { type: Boolean, default: false },
  muted: { type: Boolean, default: false },
  archived: { type: Boolean, default: false },
  clearBefore: { type: Date, default: null },
}, {
  collection: 'chat_preferences',
  versionKey: false,
});

chatPreferenceSchema.index({ chatId: 1, userId: 1 }, { unique: true });

const messageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
  senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, default: '' },
  type: { type: String, enum: ['text', 'image', 'video', 'document', 'audio'], default: 'text' },
  mediaUrl: { type: String, default: '' },
  fileName: { type: String, default: '' },
  fileSize: { type: Number, default: 0 },
  status: { type: String, enum: ['sending', 'sent', 'delivered', 'read'], default: 'delivered' },
  timestamp: { type: Date, default: Date.now, index: true },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
  forwarded: { type: Boolean, default: false },
  edited: { type: Boolean, default: false },
  editedAt: { type: Date, default: null },
  deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', default: [] }],
  starred: { type: Boolean, default: false },
  reactions: { type: Map, of: [String], default: {} },
  disappearsAt: { type: Date, default: null, index: true },
}, {
  collection: 'messages',
  versionKey: false,
});

const signupOtpSchema = new mongoose.Schema({
  name: { type: String, required: true },
  username: { type: String, required: true, index: true },
  email: { type: String, required: true, index: true },
  mobile: { type: String, default: '' },
  passwordHash: { type: String, required: true },
  avatar: { type: String, default: '🧑' },
  otpHash: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true },
  attempts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
}, {
  collection: 'signup_otps',
  versionKey: false,
});

export const User = mongoose.models.User || mongoose.model('User', userSchema);
export const Chat = mongoose.models.Chat || mongoose.model('Chat', chatSchema);
export const ChatPreference = mongoose.models.ChatPreference || mongoose.model('ChatPreference', chatPreferenceSchema);
export const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
export const SignupOtp = mongoose.models.SignupOtp || mongoose.model('SignupOtp', signupOtpSchema);



const GroupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ownerEmail: { type: String, required: true },

  // 🔥 FIXED
  isTemporary: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now },

  // only for temp groups
  expiryDate: { type: Date, default: null },

  members: [
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    role: {
      type: String,
      enum: ["admin", "member"],
      default: "member"
    }
  }
],

  status: {
    type: String,
    enum: ["active", "warning", "deleted"],
    default: "active"
  }

  
});

const MessageSchema = new mongoose.Schema({
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: "Chat", default: null },

  // 🔥 NEW
  groupId: { type: mongoose.Schema.Types.ObjectId, ref: "Group", default: null },

  senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  text: String,
  type: { type: String, default: "text" },

  timestamp: { type: Date, default: Date.now }
});

export const Group =
  mongoose.models.Group || mongoose.model("Group", GroupSchema);
