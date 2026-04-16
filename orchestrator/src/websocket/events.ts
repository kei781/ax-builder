/**
 * Unified event schema for agent ↔ orchestrator ↔ frontend communication.
 * See ARCHITECTURE.md §12.3.
 *
 * Every event carries enough context that the frontend can route it to the
 * right project view without extra lookups.
 */

export type AgentSource = 'planning' | 'building';

export type AgentEventType =
  | 'progress'       // phase advance, percent update
  | 'log'            // free-text log line (human-readable)
  | 'error'          // unrecoverable error within the agent
  | 'user_prompt'    // agent-initiated question to the user (E1)
  | 'phase_start'    // building: new phase begins
  | 'phase_end'      // building: phase concludes (success/fail)
  | 'token'          // planning: streaming assistant token
  | 'tool_call'      // planning: tool invocation (name + args)
  | 'tool_result'    // planning: tool returned
  | 'completion';    // turn/run finished

export interface AgentEvent<TPayload = unknown> {
  agent: AgentSource;
  project_id: string;
  /** Optional — only populated once a session exists. */
  session_id?: string;
  /** Optional — only populated during build runs. */
  build_id?: string;
  event_type: AgentEventType;
  /** Optional — phase name for build events, conversation phase for planning. */
  phase?: string;
  /** 0 - 100. Not all events carry progress (e.g. tokens). */
  progress_percent?: number;
  payload?: TPayload;
  /** UNIX ms; populated by the gateway on emit. */
  at?: number;
}
