import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { findNodeAtLocation, type Node as JsoncNode } from 'jsonc-parser';

import {
  isRuntimeLocalProviderLoopbackUrl,
  RUNTIME_LOCAL_PROVIDER_PRESETS,
  RuntimeLocalProviderValidationError,
} from '../../core/domain';

import type {
  RuntimeLocalProviderErrorCodeDto,
  RuntimeLocalProviderListEntryDto,
  RuntimeLocalProviderPresetDto,
} from '../../contracts';

const MAX_API_KEY_LENGTH = 8_192;
const PROVIDER_CREDENTIAL_DIRECTORY_SEGMENTS = [
  '.config',
  'opencode',
  'agent-teams-credentials',
] as const;

interface ConfiguredProviderSnapshot {
  readonly preset: RuntimeLocalProviderPresetDto;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly hasConfiguredApiKey: boolean;
  readonly configuredModelIds: readonly string[];
  readonly configuredDefaultModelId: string | null;
  readonly isDefault: boolean;
}

export class LocalProviderOperationError extends Error {
  constructor(
    readonly code: RuntimeLocalProviderErrorCodeDto,
    message: string,
    readonly recoverable = true
  ) {
    super(message);
    this.name = 'LocalProviderOperationError';
  }
}

export function normalizeOptionalProviderApiKey(value: string | null | undefined): string | null {
  const apiKey = value?.trim() ?? '';
  if (!apiKey) return null;
  const containsInvalidCharacter = [...apiKey].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint === 0 || codePoint === 10 || codePoint === 13;
  });
  if (apiKey.length > MAX_API_KEY_LENGTH || containsInvalidCharacter) {
    throw new RuntimeLocalProviderValidationError('API key is invalid.');
  }
  return apiKey;
}

export function resolveConfiguredProviderPreset(
  providerId: string,
  baseUrl: string
): RuntimeLocalProviderPresetDto | undefined {
  const customPreset = RUNTIME_LOCAL_PROVIDER_PRESETS.find(
    (candidate) => candidate.id === 'custom'
  );
  if (!isRuntimeLocalProviderLoopbackUrl(baseUrl)) return customPreset;
  return (
    RUNTIME_LOCAL_PROVIDER_PRESETS.find((candidate) => candidate.providerId === providerId) ??
    customPreset
  );
}

export function buildDeferredProviderListEntry(
  configured: ConfiguredProviderSnapshot
): RuntimeLocalProviderListEntryDto | null {
  const remote = !isRuntimeLocalProviderLoopbackUrl(configured.baseUrl);
  if (!remote && !configured.hasConfiguredApiKey) return null;
  const configuredModels = configured.configuredModelIds.map((modelId) => ({
    id: modelId,
    displayName: modelId,
  }));
  return {
    preset: configured.preset,
    providerId: configured.providerId,
    baseUrl: configured.baseUrl,
    hasConfiguredApiKey: configured.hasConfiguredApiKey,
    configuredModelIds: configured.configuredModelIds,
    defaultModelId: configured.configuredDefaultModelId ?? configured.configuredModelIds[0] ?? null,
    isDefault: configured.isDefault,
    state: 'available',
    liveModels: configuredModels,
    latencyMs: null,
    message: `${remote ? 'Remote endpoint' : 'Credential-backed endpoint'} configured. OpenCode verifies connectivity and authentication before launch.`,
  };
}

export function buildProviderApiKeyReference(input: {
  readonly configPath: string;
  readonly providerId: string;
}): string {
  const filename = buildProviderApiKeyFilename(input);
  return `{file:~/${PROVIDER_CREDENTIAL_DIRECTORY_SEGMENTS.join('/')}/${filename}}`;
}

function buildProviderApiKeyFilename(input: {
  readonly configPath: string;
  readonly providerId: string;
}): string {
  const scopeHash = createHash('sha256')
    .update(path.resolve(input.configPath))
    .digest('hex')
    .slice(0, 16);
  return `${input.providerId}-${scopeHash}.key`;
}

export function readStringNode(node: JsoncNode | undefined): string | null {
  return node?.type === 'string' && typeof node.value === 'string' ? node.value : null;
}

export function assertProviderApiKeyReplacement(
  configTree: JsoncNode,
  providerId: string,
  apiKey: string | null
): void {
  const existingApiKey = readStringNode(
    findNodeAtLocation(configTree, ['provider', providerId, 'options', 'apiKey'])
  );
  if (apiKey || !existingApiKey?.trim()) return;
  throw new LocalProviderOperationError(
    'config-conflict',
    'Enter a replacement API key before changing an existing protected provider.'
  );
}

export async function writeProviderApiKeyReference(input: {
  readonly homePath: string;
  readonly configPath: string;
  readonly providerId: string;
  readonly apiKey: string;
  readonly beforeCommit?: () => Promise<void>;
}): Promise<string> {
  let realHomePath: string;
  try {
    const homeStat = await fs.stat(input.homePath);
    if (!homeStat.isDirectory()) throw new Error('not-directory');
    realHomePath = await fs.realpath(input.homePath);
  } catch {
    throw new LocalProviderOperationError(
      'write-failed',
      'The user home directory is not available for provider credential storage.'
    );
  }

  let credentialDirectory = realHomePath;
  for (const segment of PROVIDER_CREDENTIAL_DIRECTORY_SEGMENTS) {
    credentialDirectory = path.join(credentialDirectory, segment);
    try {
      const stat = await fs.lstat(credentialDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new LocalProviderOperationError(
          'config-conflict',
          'The provider credential directory must be a regular directory.'
        );
      }
    } catch (error) {
      if (error instanceof LocalProviderOperationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalProviderOperationError(
          'write-failed',
          'Could not inspect the provider credential directory.'
        );
      }
      await fs.mkdir(credentialDirectory, { mode: 0o700 });
    }
  }

  const realCredentialDirectory = await fs.realpath(credentialDirectory);
  if (!isPathInside(realHomePath, realCredentialDirectory)) {
    throw new LocalProviderOperationError(
      'config-conflict',
      'The provider credential directory resolves outside the user home directory.'
    );
  }
  if (process.platform !== 'win32') {
    await fs.chmod(realCredentialDirectory, 0o700);
  }

  const apiKeyReference = buildProviderApiKeyReference(input);
  const filename = buildProviderApiKeyFilename(input);
  const credentialPath = path.join(realCredentialDirectory, filename);
  try {
    const existing = await fs.lstat(credentialPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new LocalProviderOperationError(
        'config-conflict',
        'The provider credential path must be a regular file.'
      );
    }
  } catch (error) {
    if (error instanceof LocalProviderOperationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LocalProviderOperationError(
        'write-failed',
        'Could not inspect the provider credential file.'
      );
    }
  }

  const beforeCommit = input.beforeCommit;
  let configCommitted = false;
  await atomicWriteAsync(credentialPath, input.apiKey, {
    mode: 0o600,
    durability: 'strict',
    syncDirectory: true,
    beforeCommit: beforeCommit
      ? async () => {
          if (configCommitted) return;
          await beforeCommit();
          configCommitted = true;
        }
      : undefined,
  });
  return apiKeyReference;
}

export async function commitProviderConfigWithCredential(input: {
  readonly homePath: string;
  readonly configPath: string;
  readonly providerId: string;
  readonly apiKey: string | null;
  readonly contents: string;
  readonly mode: number;
}): Promise<void> {
  const commitConfig = (): Promise<void> =>
    atomicWriteAsync(input.configPath, input.contents, { mode: input.mode });
  if (!input.apiKey) {
    await commitConfig();
    return;
  }
  await writeProviderApiKeyReference({
    homePath: input.homePath,
    configPath: input.configPath,
    providerId: input.providerId,
    apiKey: input.apiKey,
    // Publish the staged private key only after the config commits. A config
    // failure therefore leaves the previously active key untouched.
    beforeCommit: commitConfig,
  });
}

export function isPathInside(rootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
}
