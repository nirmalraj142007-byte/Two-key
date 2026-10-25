export type Msg = {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: { id: string; name: string; input: unknown }[];
  toolCallId?: string;
  toolResult?: string;
};

export interface ModelAdapter {
  id: string;
  step(i: {
    system: string;
    messages: Msg[];
    tools: { name: string; description: string; inputSchema: object }[];
    maxOutputTokens: number;
    temperature: number;
  }): Promise<{
    text: string;
    /** The provider's reasoning output, when it returns one. */
    reasoning?: string;
    toolCalls: { id: string; name: string; input: unknown }[];
    stop: 'end' | 'tool' | 'max_tokens';
    usage: { inputTokens: number; outputTokens: number };
  }>;
}
