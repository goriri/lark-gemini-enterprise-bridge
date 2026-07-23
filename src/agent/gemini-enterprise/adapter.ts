import { GoogleAuth } from 'google-auth-library';
import { log } from '../../core/logger';
import {
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';

export class GeminiEnterpriseAdapter implements AgentAdapter {
  readonly id = 'gemini-enterprise';
  readonly displayName = 'Gemini Enterprise';
  private botIdentity: AgentBotIdentity | undefined;
  private auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return true; // We assume it's available via API
  }

  run(opts: AgentRunOptions): AgentRun {
    const abortController = new AbortController();
    
    return {
      runId: opts.runId,
      events: this.createEventStream(opts, abortController.signal),
      async stop() {
        abortController.abort();
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        return Promise.resolve(true);
      },
    };
  }

  private async *createEventStream(opts: AgentRunOptions, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const projectId = process.env.GEMINI_ENTERPRISE_PROJECT_ID;
    const location = process.env.GEMINI_ENTERPRISE_LOCATION;
    const appId = process.env.GEMINI_ENTERPRISE_APP_ID;

    if (!projectId || !location || !appId) {
      yield {
        type: 'error',
        message: 'Missing Gemini Enterprise credentials in environment variables.',
        terminationReason: 'failed',
      };
      return;
    }

    let token: string | undefined | null;
    try {
      token = await this.auth.getAccessToken();
    } catch (e: any) {
      yield {
        type: 'error',
        message: `Missing Gemini Enterprise credentials in environment variables.please use the ADC for auth.\nError: ${e.message}`,
        terminationReason: 'failed',
      };
      return;
    }

    if (!token) {
      yield {
        type: 'error',
        message: 'Missing Gemini Enterprise credentials in environment variables.please use the ADC for auth.',
        terminationReason: 'failed',
      };
      return;
    }

    const endpoint = `https://discoveryengine.googleapis.com/v1/projects/${projectId}/locations/${location}/collections/default_collection/engines/${appId}/assistants/default_assistant:streamAssist?alt=sse`;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-goog-user-project': projectId,
        },
        body: JSON.stringify({
          query: { text: opts.prompt },
          ...(process.env.GEMINI_ENTERPRISE_ENABLE_WEB_SEARCH === 'true' 
            ? { toolsSpec: { webGroundingSpec: {} } }
            : {})
        }),
        signal,
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${await response.text()}`);
      }

      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.trim() === '' || !line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.substring(6));
              
              if (data.answer?.replies?.length > 0) {
                const text = data.answer.replies[0]?.groundedContent?.content?.text;
                if (text) {
                   yield { type: 'text', delta: text };
                }
              }
            } catch (e) {
              // ignore parse errors for incomplete chunks
            }
          }
        }
      }

      yield {
        type: 'done',
        terminationReason: 'normal',
      };
    } catch (err: any) {
      if (err.name === 'AbortError') {
        yield {
          type: 'error',
          message: 'Run interrupted',
          terminationReason: 'interrupted',
        };
      } else {
        yield {
          type: 'error',
          message: `StreamAssist failed: ${err.message}`,
          terminationReason: 'failed',
        };
      }
    }
  }
}
