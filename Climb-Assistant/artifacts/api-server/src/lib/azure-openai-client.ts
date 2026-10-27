import { AzureOpenAI } from "openai";

export const AZURE_OPENAI_DEPLOYMENT_NAME = "gpt-4o";
export const AZURE_OPENAI_API_VERSION = "2024-02-01";

export type AzureOpenAiClientOptions = {
  timeout?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
};

export function createAzureOpenAiClient(
  apiKey: string,
  endpoint: string,
  options: AzureOpenAiClientOptions = {},
): AzureOpenAI {
  return new AzureOpenAI({
    apiKey,
    endpoint,
    apiVersion: AZURE_OPENAI_API_VERSION,
    deployment: AZURE_OPENAI_DEPLOYMENT_NAME,
    ...options,
  });
}
