import axios from 'axios';
import { sandboxAxiosProxy } from './sandbox-proxy';
import { Message, ChatConfig, ChatResponse } from '../types';
import { ToolDefinition } from '../types/tool';
import { AIProvider, StreamCallbacks, ProviderCallOptions } from './provider';
import { ContextDebugLogger } from '../utils/context-debug-logger';

interface OllamaToolCall {
  function?: {
    name?: string;
    description?: string;
    arguments?: unknown;
  };
}

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  images?: string[];
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama Provider
 * 使用 Ollama native /api/chat，而不是 OpenAI-compatible /v1 shim。
 * 支持本地无 API key、function tools 和 NDJSON streaming。
 */
export class OllamaProvider implements AIProvider {
  private apiUrl: string;
  private apiKey?: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private think: boolean;
  private keepAlive: string;
  private numCtx: number;
  private toolCallSequence = 0;

  constructor(config: ChatConfig) {
    this.apiUrl = this.normalizeChatUrl(config.apiUrl || 'http://localhost:11434');
    this.apiKey = this.isLocalUrl(this.apiUrl) ? undefined : config.apiKey;
    this.model = config.model || 'llama3.2';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? 1024;
    this.think = config.ollama?.think ?? false;
    this.keepAlive = config.ollama?.keepAlive || '30m';
    this.numCtx = config.ollama?.numCtx ?? 8192;
  }

  private normalizeChatUrl(apiUrl: string): string {
    const trimmed = apiUrl.trim().replace(/\/+$/, '');
    if (!trimmed) {
      return 'http://localhost:11434/api/chat';
    }
    if (trimmed.endsWith('/api/chat')) {
      return trimmed;
    }
    if (trimmed.endsWith('/api')) {
      return `${trimmed}/chat`;
    }
    if (trimmed.endsWith('/v1/chat/completions')) {
      return `${trimmed.slice(0, -'/v1/chat/completions'.length)}/api/chat`;
    }
    if (trimmed.endsWith('/v1')) {
      return `${trimmed.slice(0, -'/v1'.length)}/api/chat`;
    }
    return `${trimmed}/api/chat`;
  }

  private isLocalUrl(apiUrl: string): boolean {
    try {
      const url = new URL(apiUrl);
      return url.hostname === 'localhost'
        || url.hostname === '127.0.0.1'
        || url.hostname === '::1';
    } catch {
      return false;
    }
  }

  private get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildRequestBody(messages: Message[], tools?: ToolDefinition[], stream = false): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.transformMessages(messages),
      stream,
      think: this.think,
      keep_alive: this.keepAlive,
      options: {
        temperature: this.temperature,
        num_ctx: this.numCtx,
        num_predict: this.maxTokens,
      },
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    return body;
  }

  private transformMessages(messages: Message[]): OllamaMessage[] {
    return messages.map(message => {
      const { content, images } = this.transformContent(message.content);
      const transformed: OllamaMessage = {
        role: message.role,
        content,
      };

      if (images.length > 0) {
        transformed.images = images;
      }

      if (message.role === 'assistant' && message.tool_calls?.length) {
        transformed.tool_calls = message.tool_calls.map(toolCall => ({
          function: {
            name: toolCall.function.name,
            arguments: this.parseArgumentsObject(toolCall.function.arguments),
          },
        }));
      }

      if (message.role === 'tool') {
        transformed.tool_name = message.name || 'unknown_tool';
      }

      return transformed;
    });
  }

  private transformContent(content: Message['content']): { content: string; images: string[] } {
    if (!content) {
      return { content: '', images: [] };
    }
    if (typeof content === 'string') {
      return { content, images: [] };
    }

    const textParts: string[] = [];
    const images: string[] = [];
    for (const block of content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else {
        images.push(block.source.data);
      }
    }

    return {
      content: textParts.join('\n'),
      images,
    };
  }

  private parseArgumentsObject(argumentsJson: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(argumentsJson || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: argumentsJson };
    }
  }

  private stringifyArguments(args: unknown): string {
    if (typeof args === 'string') {
      try {
        JSON.parse(args);
        return args;
      } catch {
        return JSON.stringify({ raw: args });
      }
    }
    if (args && typeof args === 'object') {
      return JSON.stringify(args);
    }
    return JSON.stringify({});
  }

  private parseResponse(response: OllamaChatResponse): ChatResponse {
    const message = response.message;
    const content = message?.content || null;
    const rawToolCalls = message?.tool_calls || [];
    const toolCalls = rawToolCalls
      .map((toolCall, index) => this.normalizeToolCall(toolCall, index))
      .filter((toolCall): toolCall is NonNullable<ChatResponse['toolCalls']>[number] => Boolean(toolCall));

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: this.extractUsage(response),
    };
  }

  private normalizeToolCall(toolCall: OllamaToolCall, index: number): NonNullable<ChatResponse['toolCalls']>[number] | null {
    const name = toolCall.function?.name;
    if (!name) {
      return null;
    }

    this.toolCallSequence++;
    return {
      id: `ollama_tool_${this.toolCallSequence}_${index}`,
      type: 'function',
      function: {
        name,
        arguments: this.stringifyArguments(toolCall.function?.arguments),
      },
    };
  }

  private extractUsage(response: OllamaChatResponse): ChatResponse['usage'] {
    const promptTokens = response.prompt_eval_count ?? 0;
    const completionTokens = response.eval_count ?? 0;
    if (promptTokens === 0 && completionTokens === 0) {
      return undefined;
    }
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  async chat(messages: Message[], tools?: ToolDefinition[], options?: ProviderCallOptions): Promise<ChatResponse> {
    const body = this.buildRequestBody(messages, tools, false);
    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      apiUrl: this.apiUrl,
      body,
    });

    const response = await axios.post(this.apiUrl, body, { headers: this.headers, ...sandboxAxiosProxy(), signal: options?.abortSignal });

    ContextDebugLogger.dumpSdkBoundary('after', undefined, {
      response: response.data,
    });

    return this.parseResponse(response.data);
  }

  async chatStream(messages: Message[], tools?: ToolDefinition[], callbacks?: StreamCallbacks, options?: ProviderCallOptions): Promise<ChatResponse> {
    const body = this.buildRequestBody(messages, tools, true);
    ContextDebugLogger.dumpSdkBoundary('before', undefined, {
      apiUrl: this.apiUrl,
      body,
    });

    const response = await axios.post(this.apiUrl, body, {
      ...sandboxAxiosProxy(),
      headers: this.headers,
      responseType: 'stream',
      signal: options?.abortSignal,
    });

    return new Promise<ChatResponse>((resolve, reject) => {
      let fullContent = '';
      let buffer = '';
      let streamUsage: ChatResponse['usage'];
      const toolCalls: NonNullable<ChatResponse['toolCalls']> = [];
      const stream = response.data;

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        try {
          const parsed = JSON.parse(trimmed) as OllamaChatResponse;
          const content = parsed.message?.content || '';
          if (content) {
            fullContent += content;
            callbacks?.onText?.(content);
          }

          if (parsed.message?.tool_calls?.length) {
            for (const rawToolCall of parsed.message.tool_calls) {
              const normalized = this.normalizeToolCall(rawToolCall, toolCalls.length);
              if (normalized) {
                toolCalls.push(normalized);
              }
            }
          }

          const usage = this.extractUsage(parsed);
          if (usage) {
            streamUsage = usage;
          }
        } catch {
          // Ignore malformed partial lines; the next chunk may complete them.
        }
      };

      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          handleLine(line);
        }
      });

      stream.on('end', () => {
        if (buffer.trim()) {
          handleLine(buffer);
        }

        const result: ChatResponse = {
          content: fullContent || null,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage: streamUsage,
        };

        ContextDebugLogger.dumpSdkBoundary('after', undefined, {
          response: result,
        });

        callbacks?.onComplete?.(result);
        resolve(result);
      });

      stream.on('error', (err: Error) => {
        callbacks?.onError?.(err);
        reject(err);
      });
    });
  }
}
