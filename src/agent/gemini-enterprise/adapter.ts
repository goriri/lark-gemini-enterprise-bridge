import { GoogleAuth } from 'google-auth-library';
import { log } from '../../core/logger';
import {
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';

export async function fetchGeminiEnterpriseOptions() {
  const projectId = process.env.GEMINI_ENTERPRISE_PROJECT_ID;
  const location = process.env.GEMINI_ENTERPRISE_LOCATION;
  const collection = 'default_collection';
  if (!projectId || !location) return null;

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  let agents: string[] = [];
  let datastores: string[] = [];

  try {
    const res = await client.request<any>({
      url: `https://discoveryengine.googleapis.com/v1alpha/projects/${projectId}/locations/${location}/collections/${collection}/engines`
    });
    agents = (res.data.engines || []).map((e: any) => e.name.split('/').pop());
  } catch (e: any) {
    console.error('Error fetching engines:', e.message);
  }

  try {
    const res = await client.request<any>({
      url: `https://discoveryengine.googleapis.com/v1alpha/projects/${projectId}/locations/${location}/collections/${collection}/dataStores`
    });
    datastores = (res.data.dataStores || []).map((e: any) => e.name.split('/').pop());
  } catch (e: any) {
    console.error('Error fetching datastores:', e.message);
  }

  return { agents, datastores };
}

interface ChatState {
  sessionId?: string;
  agentId?: string;
  dataSources?: string[] | 'all';
  webSearch?: boolean;
}
const chatStates = new Map<string, ChatState>();

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

    // Extract chatId
    const chatIdMatch = opts.prompt.match(/"chatId":"([^"]+)"/);
    const chatId: string = chatIdMatch && chatIdMatch[1] ? chatIdMatch[1] : 'default';
    const state: ChatState = chatStates.get(chatId) || {};

    // Determine user message part to avoid matching history
    let userMessage = opts.prompt;
    
    // Parse metadata commands
    if (/#agents\b/.test(userMessage)) {
      const opts = await fetchGeminiEnterpriseOptions();
      yield { type: 'text', delta: `Available Agents:\n${opts?.agents.map(a => `- ${a}`).join('\n') || 'None'}` };
      yield { type: 'done', terminationReason: 'normal' };
      return;
    }
    if (/#data_sources\b/.test(userMessage)) {
      const opts = await fetchGeminiEnterpriseOptions();
      yield { type: 'text', delta: `Available Data Sources:\n${opts?.datastores.map(d => `- ${d}`).join('\n') || 'None'}` };
      yield { type: 'done', terminationReason: 'normal' };
      return;
    }

    // State mutations
    let isMetadataOnly = false;
    if (/#web_search\b/.test(userMessage)) {
      state.webSearch = true;
    }
    const agentMatch = userMessage.match(/#agent\s+([a-zA-Z0-9-_]+)/);
    if (agentMatch) {
      state.agentId = agentMatch[1];
    }
    if (/#all_ds\b/.test(userMessage)) {
      state.dataSources = 'all';
    }
    const dsMatch = userMessage.match(/#ds\s+\[(.*?)\]/);
    if (dsMatch && dsMatch[1]) {
      state.dataSources = dsMatch[1].split(',').map(s => s.trim());
    }

    let token: string | undefined | null;
    try {
      token = await this.auth.getAccessToken();
    } catch (e: any) {
      yield { type: 'error', message: `Missing credentials. Error: ${e.message}`, terminationReason: 'failed' };
      return;
    }

    if (/#new\b/.test(userMessage)) {
      try {
        const res = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${projectId}/locations/${location}/collections/default_collection/engines/${appId}/sessions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'x-goog-user-project': projectId },
          body: JSON.stringify({ state: 'IN_PROGRESS' })
        });
        if (res.ok) {
          const data: any = await res.json();
          state.sessionId = data.name; // Full session resource name
          const opts = await fetchGeminiEnterpriseOptions();
          let deltaMsg = `Created new session: ${state.sessionId?.split('/').pop()}`;
          if (opts) {
            deltaMsg += `\n\nAvailable Agents:\n${opts.agents.map(a => `- ${a}`).join('\n') || 'None'}`;
            deltaMsg += `\n\nAvailable Data Sources:\n${opts.datastores.map(d => `- ${d}`).join('\n') || 'None'}`;
          }
          yield { type: 'text', delta: deltaMsg };
          isMetadataOnly = true;
        } else {
          yield { type: 'text', delta: `Failed to create session: ${await res.text()}` };
        }
      } catch (e: any) {
        yield { type: 'text', delta: `Failed to create session: ${e.message}` };
      }
    }

    if (/#sessions\b/.test(userMessage)) {
      try {
        const res = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${projectId}/locations/${location}/collections/default_collection/engines/${appId}/sessions`, {
          headers: { 'Authorization': `Bearer ${token}`, 'x-goog-user-project': projectId }
        });
        if (res.ok) {
          const data: any = await res.json();
          const sessionIds = (data.sessions || []).map((s: any) => s.name.split('/').pop());
          yield { type: 'text', delta: `Existing sessions:\n${sessionIds.map((id: string) => `- ${id}`).join('\n') || 'None'}` };
        } else {
          yield { type: 'text', delta: `Failed to list sessions: ${await res.text()}` };
        }
      } catch (e: any) {
        yield { type: 'text', delta: `Failed to list sessions: ${e.message}` };
      }
      isMetadataOnly = true;
    }

    const sessionIdMatch = userMessage.match(/#session_id\s+([a-zA-Z0-9-_]+)/);
    if (sessionIdMatch) {
      state.sessionId = `projects/${projectId}/locations/${location}/collections/default_collection/engines/${appId}/sessions/${sessionIdMatch[1]}`;
      yield { type: 'text', delta: `Continuing session ${sessionIdMatch[1]}... ` };
    }

    chatStates.set(chatId, state);

    // Clean prompt of all hashtags
    const cleanPrompt = opts.prompt
      .replace(/#(new|sessions|agents|data_sources|all_ds|web_search)\b/g, '')
      .replace(/#agent\s+[a-zA-Z0-9-_]+/g, '')
      .replace(/#session_id\s+[a-zA-Z0-9-_]+/g, '')
      .replace(/#ds\s+\[.*?\]/g, '')
      .replace(/@[a-zA-Z0-9-]+/g, '') // Also clean the @tags from before
      .trim();

    if (isMetadataOnly && !cleanPrompt.trim()) {
      yield { type: 'done', terminationReason: 'normal' };
      return;
    }

    const endpoint = `https://discoveryengine.googleapis.com/v1alpha/projects/${projectId}/locations/${location}/collections/default_collection/engines/${appId}/assistants/default_assistant:streamAssist?alt=sse`;

    const requestBody: any = {
      query: { text: cleanPrompt || opts.prompt },
    };

    if (state.sessionId) {
      requestBody.session = state.sessionId;
    }

    if (state.agentId) {
      requestBody.agentsSpec = {
        agentSpecs: [{ agentId: state.agentId }]
      };
    }

    const toolsSpec: any = {};
    if (state.webSearch || process.env.GEMINI_ENTERPRISE_ENABLE_WEB_SEARCH === 'true') {
      toolsSpec.webGroundingSpec = {};
    }
    
    if (state.dataSources === 'all') {
      const opts = await fetchGeminiEnterpriseOptions();
      if (opts && opts.datastores.length > 0) {
        toolsSpec.vertexAiSearchSpec = {
          dataStoreSpecs: opts.datastores.map(id => ({
            dataStore: `projects/${projectId}/locations/${location}/collections/default_collection/dataStores/${id}`
          }))
        };
      }
    } else if (Array.isArray(state.dataSources) && state.dataSources.length > 0) {
      toolsSpec.vertexAiSearchSpec = {
        dataStoreSpecs: state.dataSources.map(id => ({
          dataStore: `projects/${projectId}/locations/${location}/collections/default_collection/dataStores/${id}`
        }))
      };
    }
    
    if (Object.keys(toolsSpec).length > 0) {
      requestBody.toolsSpec = toolsSpec;
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'x-goog-user-project': projectId,
        },
        body: JSON.stringify(requestBody),
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
