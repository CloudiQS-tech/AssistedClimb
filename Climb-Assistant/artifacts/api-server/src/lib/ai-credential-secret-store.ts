import { randomBytes, timingSafeEqual } from "crypto";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

const REFERENCE_PATTERN = /^[a-f0-9]{32}$/;
const SECRET_PREFIX_PATTERN = /^[A-Za-z0-9/_+=.@-]{1,200}$/;
const KMS_KEY_ARN_PATTERN = /^arn:(aws|aws-us-gov|aws-cn):kms:([^:]+):[0-9]{12}:key\/[A-Fa-f0-9-]+$/;
const SECRET_MAX_BYTES = 65_536;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CACHE_MAX_ENTRIES = 500;
const SECRET_DELETION_RECOVERY_DAYS = 7;

export class AiCredentialSecretStoreError extends Error {
  constructor() {
    super("School AI credential storage is unavailable.");
    this.name = "AiCredentialSecretStoreError";
  }
}

export type AiCredentialSecretStoreConfig = {
  region: string;
  secretPrefix: string;
  kmsKeyArn: string;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  now?: () => number;
};

type SecretsManagerClientLike = {
  send(command: any): Promise<any>;
};

type CachedCredential = {
  value: string;
  expiresAt: number;
};

type PendingCredential = {
  promise: Promise<string>;
  invalidated: boolean;
};

function credentialsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function isAwsErrorNamed(error: unknown, name: string): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === name);
}

function validateConfiguration(config: AiCredentialSecretStoreConfig): void {
  const prefixParts = config.secretPrefix.split("/");
  const kmsMatch = KMS_KEY_ARN_PATTERN.exec(config.kmsKeyArn);
  if (
    !config.region
    || !SECRET_PREFIX_PATTERN.test(config.secretPrefix)
    || config.secretPrefix.startsWith("/")
    || config.secretPrefix.endsWith("/")
    || prefixParts.some((part) => !part || part === "." || part === "..")
    || !kmsMatch
    || kmsMatch[2] !== config.region
  ) {
    throw new AiCredentialSecretStoreError();
  }
}

export class AiCredentialSecretStore {
  private readonly cache = new Map<string, CachedCredential>();
  private readonly inFlight = new Map<string, PendingCredential>();
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly now: () => number;
  private readonly client: SecretsManagerClientLike;
  private readonly config: AiCredentialSecretStoreConfig;

  constructor(
    client: SecretsManagerClientLike,
    config: AiCredentialSecretStoreConfig,
  ) {
    this.client = client;
    this.config = config;
    validateConfiguration(config);
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cacheMaxEntries = config.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.now = config.now ?? Date.now;
    if (this.cacheTtlMs < 1 || this.cacheMaxEntries < 1) {
      throw new AiCredentialSecretStoreError();
    }
  }

  private secretName(organisationId: number, reference: string): string {
    if (!Number.isSafeInteger(organisationId) || organisationId < 1 || !REFERENCE_PATTERN.test(reference)) {
      throw new AiCredentialSecretStoreError();
    }
    return `${this.config.secretPrefix}/organisations/${organisationId}/ai-credentials/${reference}`;
  }

  private cacheKey(organisationId: number, reference: string): string {
    return `${organisationId}:${reference}`;
  }

  private cacheCredential(key: string, value: string): void {
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: this.now() + this.cacheTtlMs });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchCredential(secretName: string): Promise<string> {
    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretName }));
      if (typeof result.SecretString !== "string" || !result.SecretString) {
        throw new AiCredentialSecretStoreError();
      }
      return result.SecretString;
    } catch {
      throw new AiCredentialSecretStoreError();
    }
  }

  async get(organisationId: number, reference: string): Promise<string> {
    const secretName = this.secretName(organisationId, reference);
    const key = this.cacheKey(organisationId, reference);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.value;
    }
    this.cache.delete(key);

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = { promise: this.fetchCredential(secretName), invalidated: false };
      this.inFlight.set(key, pending);
    }
    try {
      const value = await pending.promise;
      if (!pending.invalidated) {
        this.cacheCredential(key, value);
      }
      return value;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  async create(
    organisationId: number,
    credential: string,
    reference = randomBytes(16).toString("hex"),
  ): Promise<string> {
    const secretName = this.secretName(organisationId, reference);
    if (!credential || Buffer.byteLength(credential, "utf8") > SECRET_MAX_BYTES) {
      throw new AiCredentialSecretStoreError();
    }

    let created = false;
    try {
      await this.client.send(new CreateSecretCommand({
        Name: secretName,
        KmsKeyId: this.config.kmsKeyArn,
        SecretString: credential,
        Tags: [
          { Key: "Application", Value: "assisted-climb" },
          { Key: "OrganisationId", Value: String(organisationId) },
          { Key: "Purpose", Value: "school-ai-provider-credential" },
        ],
      }));
      created = true;
    } catch (error) {
      if (!isAwsErrorNamed(error, "ResourceExistsException")) {
        throw new AiCredentialSecretStoreError();
      }
      this.invalidate(organisationId, reference);
      const existing = await this.fetchCredential(secretName);
      if (!credentialsEqual(existing, credential)) {
        throw new AiCredentialSecretStoreError();
      }
      this.cacheCredential(this.cacheKey(organisationId, reference), existing);
      return reference;
    }

    this.invalidate(organisationId, reference);
    try {
      const stored = await this.fetchCredential(secretName);
      if (!credentialsEqual(stored, credential)) {
        throw new AiCredentialSecretStoreError();
      }
      this.cacheCredential(this.cacheKey(organisationId, reference), stored);
      return reference;
    } catch {
      if (created) {
        try {
          await this.client.send(new DeleteSecretCommand({
            SecretId: secretName,
            RecoveryWindowInDays: SECRET_DELETION_RECOVERY_DAYS,
          }));
        } catch {
          // The caller receives only a generic failure; cleanup is best effort.
        }
      }
      throw new AiCredentialSecretStoreError();
    }
  }

  async delete(organisationId: number, reference: string): Promise<void> {
    const secretName = this.secretName(organisationId, reference);
    this.invalidate(organisationId, reference);
    try {
      await this.client.send(new DeleteSecretCommand({
        SecretId: secretName,
        RecoveryWindowInDays: SECRET_DELETION_RECOVERY_DAYS,
      }));
    } catch (error) {
      if (isAwsErrorNamed(error, "ResourceNotFoundException")) return;
      if (isAwsErrorNamed(error, "InvalidRequestException")) return;
      throw new AiCredentialSecretStoreError();
    }
  }

  invalidate(organisationId: number, reference: string): void {
    const key = this.cacheKey(organisationId, reference);
    this.cache.delete(key);
    const pending = this.inFlight.get(key);
    if (pending) pending.invalidated = true;
    this.inFlight.delete(key);
  }
}

let defaultStore: AiCredentialSecretStore | undefined;

function getDefaultStore(): AiCredentialSecretStore {
  if (defaultStore) return defaultStore;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  const secretPrefix = process.env.AI_CREDENTIAL_SECRET_PREFIX;
  const kmsKeyArn = process.env.AI_CREDENTIAL_KMS_KEY_ARN;
  if (!region || !secretPrefix || !kmsKeyArn) {
    throw new AiCredentialSecretStoreError();
  }
  try {
    const config = { region, secretPrefix, kmsKeyArn };
    defaultStore = new AiCredentialSecretStore(
      new SecretsManagerClient({ region, maxAttempts: 2 }),
      config,
    );
    return defaultStore;
  } catch {
    throw new AiCredentialSecretStoreError();
  }
}

export function getAiCredentialSecret(
  organisationId: number,
  reference: string,
): Promise<string> {
  return getDefaultStore().get(organisationId, reference);
}

export function createAiCredentialSecret(
  organisationId: number,
  credential: string,
  reference?: string,
): Promise<string> {
  return getDefaultStore().create(organisationId, credential, reference);
}

export function deleteAiCredentialSecret(
  organisationId: number,
  reference: string,
): Promise<void> {
  return getDefaultStore().delete(organisationId, reference);
}

export function invalidateAiCredentialSecret(
  organisationId: number,
  reference: string,
): void {
  defaultStore?.invalidate(organisationId, reference);
}