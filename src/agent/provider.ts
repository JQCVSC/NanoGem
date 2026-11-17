import {
  DEFAULT_GEMINI_MODEL,
  isConfiguredGeminiApiKey,
  runGeminiAgent,
  type AgentRunInput,
  type AgentRunResult,
  type AgentServiceDependencies,
} from "./agentService.ts";

export type AgentProviderId = "gemini";

export interface AgentProviderCapabilities {
  supportsToolCalling: boolean;
  supportsSystemInstruction: boolean;
  supportsTemperature: boolean;
  supportsLongContextWindow: boolean;
  gemini?: {
    defaultModel: string;
    supportsFunctionDeclarations: boolean;
  };
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  readonly displayName: string;
  readonly capabilities: AgentProviderCapabilities;
  isConfigured(env?: NodeJS.ProcessEnv): boolean;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export class GeminiAgentProvider implements AgentProvider {
  public readonly id = "gemini" as const;
  public readonly displayName = "Google Gemini";
  public readonly capabilities: AgentProviderCapabilities = {
    supportsToolCalling: true,
    supportsSystemInstruction: true,
    supportsTemperature: true,
    supportsLongContextWindow: true,
    gemini: {
      defaultModel: DEFAULT_GEMINI_MODEL,
      supportsFunctionDeclarations: true,
    },
  };

  private readonly deps: AgentServiceDependencies;

  constructor(deps: AgentServiceDependencies = {}) {
    this.deps = deps;
  }

  isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    if (this.deps.client) return true;
    return isConfiguredGeminiApiKey(this.deps.apiKey ?? env.GEMINI_API_KEY);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return runGeminiAgent(input, this.deps);
  }
}

/**
 * Resolves the configured agent provider. Gemini is the default and only enabled provider.
 */
export function resolveAgentProvider(
  rawProvider?: string,
  deps: AgentServiceDependencies = {},
  env: NodeJS.ProcessEnv = process.env
): AgentProvider {
  const selected = (rawProvider ?? env.NANOGEM_PROVIDER ?? "gemini")
    .trim()
    .toLowerCase();

  if (!selected || selected === "gemini") {
    return new GeminiAgentProvider(deps);
  }

  throw new Error(
    `Unsupported agent provider "${selected}". Only "gemini" is enabled in NanoGem.`
  );
}
