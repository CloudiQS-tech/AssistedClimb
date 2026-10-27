import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const AI_CREDENTIAL_CIPHERTEXT_VERSION = "v1";

function deriveKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET environment variable is required");
  }
  return scryptSync(secret, "assisted-climb-salt", 32);
}

function deriveAiCredentialKey(): Buffer {
  const secret = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY must be a 64-character hex-encoded 32-byte key");
  }
  return Buffer.from(secret, "hex");
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptWithKey(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3 || parts.some((part) => !/^(?:[a-f0-9]{2})*$/i.test(part))) {
    throw new Error("Invalid encrypted format");
  }
  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error("Invalid encrypted format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString("utf8");
}

export function encrypt(plaintext: string): string {
  return encryptWithKey(plaintext, deriveKey());
}

export function decrypt(ciphertext: string): string {
  return decryptWithKey(ciphertext, deriveKey());
}

export function encryptAiCredential(plaintext: string): string {
  return `${AI_CREDENTIAL_CIPHERTEXT_VERSION}:${encryptWithKey(plaintext, deriveAiCredentialKey())}`;
}

export function isLegacyAiCredentialCiphertext(ciphertext: string): boolean {
  return !/^v[0-9]+:/.test(ciphertext);
}

export function decryptAiCredential(ciphertext: string): string {
  const versionMatch = /^v([0-9]+):(.*)$/s.exec(ciphertext);
  if (!versionMatch) {
    // Compatibility for existing rows; re-encrypt them with the dedicated key
    // before removing this legacy path.
    return decrypt(ciphertext);
  }

  if (`v${versionMatch[1]}` !== AI_CREDENTIAL_CIPHERTEXT_VERSION) {
    throw new Error("Unsupported AI credential ciphertext version");
  }

  return decryptWithKey(versionMatch[2], deriveAiCredentialKey());
}
