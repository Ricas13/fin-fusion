'use strict';

const crypto = require('crypto');
const fs = require('fs');

const MAGIC = Buffer.from('CFBK1\n', 'utf8');
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const SCRYPT_COST = 16384;

function requireBackupKey() {
  const key = String(process.env.BACKUP_ENCRYPTION_KEY || '');
  if (key.length < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must be at least 32 characters');
  }
  return key;
}

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, KEY_BYTES, { N: SCRYPT_COST });
}

function buildHeader({ salt, iv, createdAt = new Date().toISOString() }) {
  const metadata = Buffer.from(JSON.stringify({
    version: 1,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    createdAt,
    salt: salt.toString('base64'),
    iv: iv.toString('base64')
  }) + '\n', 'utf8');
  return Buffer.concat([MAGIC, metadata]);
}

function parseHeader(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const maxHeader = Buffer.alloc(4096);
    const bytes = fs.readSync(fd, maxHeader, 0, maxHeader.length, 0);
    const data = maxHeader.subarray(0, bytes);
    if (!data.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('Invalid CAPTAiNFiN backup header');
    }
    const newline = data.indexOf(0x0a, MAGIC.length);
    if (newline === -1) throw new Error('Incomplete CAPTAiNFiN backup header');
    const metadata = JSON.parse(data.subarray(MAGIC.length, newline).toString('utf8'));
    if (metadata.version !== 1 || metadata.cipher !== 'aes-256-gcm' || metadata.kdf !== 'scrypt') {
      throw new Error('Unsupported CAPTAiNFiN backup format');
    }
    return {
      metadata,
      headerBytes: newline + 1,
      salt: Buffer.from(metadata.salt, 'base64'),
      iv: Buffer.from(metadata.iv, 'base64')
    };
  } finally {
    fs.closeSync(fd);
  }
}

function createEncryptionContext(secret = requireBackupKey()) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  return { header: buildHeader({ salt, iv }), cipher };
}

function createDecryptionContext(filePath, secret = requireBackupKey()) {
  const { metadata, headerBytes, salt, iv } = parseHeader(filePath);
  const stat = fs.statSync(filePath);
  if (stat.size <= headerBytes + TAG_BYTES) throw new Error('Backup payload is truncated');
  const tag = Buffer.alloc(TAG_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, tag, 0, TAG_BYTES, stat.size - TAG_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  const key = deriveKey(secret, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return {
    metadata,
    decipher,
    payloadStart: headerBytes,
    payloadEnd: stat.size - TAG_BYTES - 1
  };
}

module.exports = {
  TAG_BYTES,
  requireBackupKey,
  createEncryptionContext,
  createDecryptionContext,
  parseHeader
};
