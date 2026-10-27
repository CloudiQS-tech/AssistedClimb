const APPROVED_AZURE_ENDPOINT_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
  ".openai.azure.us",
  ".services.ai.azure.us",
  ".cognitiveservices.azure.us",
  ".openai.azure.cn",
  ".services.ai.azure.cn",
  ".cognitiveservices.azure.cn",
];

const AZURE_RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeApprovedAzureOpenAiEndpoint(value: string): string | null {
  let endpoint: URL;
  try {
    endpoint = new URL(value.trim());
  } catch {
    return null;
  }

  if (
    endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || endpoint.port
    || endpoint.pathname !== "/"
    || endpoint.search
    || endpoint.hash
    || endpoint.hostname.endsWith(".")
  ) {
    return null;
  }

  const hostname = endpoint.hostname.toLowerCase();
  const approved = APPROVED_AZURE_ENDPOINT_SUFFIXES.some((suffix) => {
    if (!hostname.endsWith(suffix)) return false;
    const resourceName = hostname.slice(0, -suffix.length);
    return AZURE_RESOURCE_NAME.test(resourceName);
  });

  return approved ? endpoint.origin : null;
}

export function requireApprovedAzureOpenAiEndpoint(value: string): string {
  const endpoint = normalizeApprovedAzureOpenAiEndpoint(value);
  if (!endpoint) {
    throw new Error("Azure OpenAI endpoint must be an HTTPS Azure OpenAI or Azure AI resource endpoint");
  }
  return endpoint;
}