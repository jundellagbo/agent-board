/**
 * Hands the running session to Claude Code's remote control, so the agent can be
 * driven from a phone rather than only from this window.
 *
 * Sent into the session as a person would type it, because there is no flag for
 * it — which is also why it waits until the agent is actually up.
 */
export const REMOTE_COMMAND = "/remote-control";
