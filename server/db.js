import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

let connectionPromise = null;

export async function connectToDatabase() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connectionPromise) return connectionPromise;

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is not configured.');
  }

  connectionPromise = mongoose.connect(mongoUri, {
    dbName: process.env.MONGO_DB_NAME || undefined,
  }).then(instance => instance.connection);

  try {
    return await connectionPromise;
  } finally {
    connectionPromise = null;
  }
}
