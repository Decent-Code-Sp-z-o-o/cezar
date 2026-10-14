import { firstConfiguredModel, readNativeSettingsFiles } from './shared.ts';
import type { AgentModelSettingsStrategy } from './types.ts';

/**
 * ollama's native-settings policy, expressed the same way every other runner's is.
 *
 * Ollama has no settings FILE cezar could read — its configuration surface is the server's own
 * env (`OLLAMA_HOST`, `OLLAMA_MODELS`, …) and whatever model the caller names — so nothing in
 * the agent-config catalog (`catalog.ts`) lists `ollama` among its runners and this reports
 * "no native default", which is the truthful answer. Going through the shared reader rather
 * than returning `{}` outright means the day an ollama config file IS catalogued, this strategy
 * starts honoring it with no change here (the pi posture, verbatim).
 */
export const ollamaModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'ollama',
  async read(repoRoot, env) {
    return { model: firstConfiguredModel(await readNativeSettingsFiles('ollama', repoRoot, env)) };
  },
};
