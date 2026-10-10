import { z } from 'zod';

/**
 * Web terminal (spec `.ai/specs/2026-10-10-terminal-tab.md`). One HTTP shape: the
 * session POST that mints a single-use upgrade token. The WS frames that carry
 * terminal bytes afterwards are NOT contract — they are the transport's own
 * protocol, defined next to the hub that speaks it
 * (`packages/cezar/src/server/terminal.ts`), the same place the `/api/v1/ws`
 * bus keeps its frames.
 */
export const terminalSessionBodySchema = z.object({
  /** View columns at spawn time; the PTY is sized to match the emulator. */
  cols: z.number().int().min(2).max(500).optional(),
  /** View rows at spawn time; the PTY is sized to match the emulator. */
  rows: z.number().int().min(2).max(300).optional(),
});
export type TerminalSessionBody = z.infer<typeof terminalSessionBodySchema>;

export const terminalSessionResponseSchema = z.object({
  /** Single-use, 30-second token. Consumed by exactly one WS upgrade. */
  token: z.string().min(1),
  /** Path to open: `/api/v1/p/<projectId>/terminal/ws`. Open it with `?token=`
   *  on the origin that served the cockpit. */
  wsPath: z.string().min(1),
});
export type TerminalSessionResponse = z.infer<typeof terminalSessionResponseSchema>;
