import type {
  RuntimeLocalProviderPresetIdDto,
  RuntimeProviderManagementErrorCodeDto,
} from '../contracts';

export const SERVER_START_GUIDANCE: Record<RuntimeLocalProviderPresetIdDto, string> = {
  ollama:
    'Make sure Ollama is running and at least one model has been pulled locally. Agent Teams tool use needs an effective 16K-32K context; Ollama defaults to 4K unless configured separately.',
  'lm-studio': 'In LM Studio, load a model, open Developer > Local Server, and start the server.',
  'atomic-chat': 'Open Atomic Chat, load a model, and start its local API server.',
  'llama.cpp': 'Start llama-server with a model loaded. The default port for this setup is 8080.',
  custom:
    'Start an OpenAI-compatible API with a working /v1/models endpoint. Remote endpoints must use HTTPS.',
};

export function getFriendlyVerificationError(
  errorCode: RuntimeProviderManagementErrorCodeDto,
  serverName: string
): string {
  switch (errorCode) {
    case 'runtime-missing':
      return 'OpenCode is not available yet. Install or repair OpenCode, then retry verification.';
    case 'runtime-misconfigured':
    case 'runtime-unhealthy':
      return 'OpenCode is not ready to run this model. Reopen provider settings, check the OpenCode status, then retry.';
    case 'provider-missing':
      return `${serverName} is saved, but OpenCode could not load this provider. Reopen provider settings, then retry.`;
    case 'auth-required':
    case 'auth-failed':
      return `${serverName} rejected the request. Check the local server access settings, then retry.`;
    case 'model-missing':
      return `The selected model is no longer available in ${serverName}. Load it again, refresh models, then retry.`;
    case 'model-test-failed':
      return `OpenCode could not get a response from ${serverName}. Make sure the server and selected model are running, then retry.`;
    default:
      return 'OpenCode could not verify the local model. Check the server, then retry.';
  }
}
