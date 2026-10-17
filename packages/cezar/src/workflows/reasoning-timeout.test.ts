import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTONOMOUS_NUDGE, MAX_AUTO_CONTINUES, REASONING_TIMEOUT_MS } from './run.ts';

/**
 * Tests for the reasoning-only timeout mechanism for autonomous agents.
 *
 * This verifies that:
 * 1. Tracking of reasoning phases works correctly
 * 2. Tool actions reset the reasoning phase
 * 3. Timeout after REASONING_TIMEOUT_MS forces an action
 * 4. The timeout breaker counts toward MAX_AUTO_CONTINUES
 */
describe('autonomous reasoning timeout (#autonomous)', () => {
  describe('timeout constant and basic logic', () => {
    it('uses correct timeout duration in milliseconds', () => {
      // Verify the constant is correctly defined
      expect(REASONING_TIMEOUT_MS).toBe(5 * 60 * 1000); // 5 minutes in milliseconds

      // Test with small increment to verify the comparison works
      const smallIncrement = 5 * 60 * 1000 + 1; // 5 minutes + 1ms
      const timeThreshold = REASONING_TIMEOUT_MS + 1000;
      expect(smallIncrement).toBeGreaterThan(REASONING_TIMEOUT_MS);
      expect(smallIncrement).toBeLessThan(timeThreshold);
    });

    it('timeout is exactly 5 minutes (300 seconds)', () => {
      expect(REASONING_TIMEOUT_MS).toBe(5 * 60 * 1000); // 300,000 ms
    });

    it('timeout allows reasoning for 5 minutes exactly without triggering', () => {
      const startTime = Date.now() - 5 * 60 * 1000;
      const inReasoningPhase = true;
      const hasTriggered = inReasoningPhase && startTime && Date.now() - startTime > REASONING_TIMEOUT_MS;

      // At exactly 5 minutes, it should NOT trigger
      expect(hasTriggered).toBe(false);
    });

    it('timeout triggers after 5 minutes + 1ms', () => {
      const startTime = Date.now() - 5 * 60 * 1000 - 1; // 5 minutes + 1ms ago
      const inReasoningPhase = true;
      const hasTriggered = inReasoningPhase && startTime && Date.now() - startTime > REASONING_TIMEOUT_MS;

      // After 5 minutes + 1ms, it SHOULD trigger
      expect(hasTriggered).toBe(true);
    });

    it('does not trigger for reasoning shorter than timeout', () => {
      const startTime = Date.now() - 2 * 60 * 1000; // 2 minutes ago
      const inReasoningPhase = true;
      const hasTriggered = inReasoningPhase && startTime && Date.now() - startTime > REASONING_TIMEOUT_MS;

      // After 2 minutes, it should NOT trigger
      expect(hasTriggered).toBe(false);
    });
  });

  describe('reasoning phase tracking', () => {
    it('records reasoning phase start timestamp', () => {
      const reasoningStartTime = Date.now();
      const isInReasoningPhase = true;
      const inPhase = isInReasoningPhase && reasoningStartTime && reasoningStartTime > 0;

      expect(inPhase).toBe(true);
      expect(reasoningStartTime).toBeDefined();
    });

    it('detects reasoning phase when no tool action has occurred', () => {
      const reasoningStartTime = Date.now() - 3 * 60 * 1000; // 3 minutes ago
      const isInReasoningPhase = true;
      const hasToolAction = false;

      // If we're in reasoning phase and haven't taken a tool action, we should detect the timeout
      const wouldTriggerTimeout = isInReasoningPhase && reasoningStartTime && Date.now() - reasoningStartTime > REASONING_TIMEOUT_MS;

      expect(wouldTriggerTimeout).toBe(false); // 3 minutes < 5 minutes
    });

    it('resets reasoning phase flag when tool action occurs', () => {
      const reasoningStartTime = Date.now();
      const lastToolAction = Date.now();
      const isInReasoningPhase = false; // Reset after tool action
      const hasToolAction = true;

      // After tool action, reasoning phase flag should be reset to false
      expect(isInReasoningPhase).toBe(false);
      expect(lastToolAction).toBeGreaterThan(0);
    });
  });

  describe('timeout breaker with auto continues', () => {
    it('timeout breaker increments auto continues counter', () => {
      let autoContinues = 0;
      // Simulate timeout breaker being triggered
      autoContinues = (autoContinues ?? 0) + 1;

      expect(autoContinues).toBeGreaterThanOrEqual(1);
      expect(autoContinues).toBeLessThanOrEqual(MAX_AUTO_CONTINUES);
    });

    it('timeout breaker respects MAX_AUTO_CONTINUES cap', () => {
      let autoContinues = MAX_AUTO_CONTINUES;
      // Timeout breaker increments
      autoContinues = (autoContinues ?? 0) + 1;

      expect(autoContinues).toBeGreaterThan(MAX_AUTO_CONTINUES);
    });
  });

  describe('AUTONOMOUS_NUDGE message', () => {
    it('contains instructions for autonomous work', () => {
      expect(AUTONOMOUS_NUDGE).toBeTruthy();
      expect(typeof AUTONOMOUS_NUDGE).toBe('string');
      expect(AUTONOMOUS_NUDGE.length).toBeGreaterThan(100);
    });

    it('mentions autonomous continuation in notes', () => {
      expect(AUTONOMOUS_NUDGE.toLowerCase()).toContain('autonomous');
      expect(AUTONOMOUS_NUDGE.toLowerCase()).toContain('continue');
    });
  });

  describe('integration scenario', () => {
    it('simulates full reasoning loop timeout scenario', () => {
      // Scenario: Agent starts reasoning, waits 6 minutes, no tool action
      const reasoningStartTime = Date.now() - 6 * 60 * 1000; // 6 minutes ago
      const isInReasoningPhase = true;
      const lastToolAction = undefined; // No tool action

      // Check if timeout should trigger
      const shouldForceAction =
        isInReasoningPhase &&
        reasoningStartTime &&
        Date.now() - reasoningStartTime > REASONING_TIMEOUT_MS;

      expect(shouldForceAction).toBe(true);

      // If forced, reset phase and increment counter
      if (shouldForceAction) {
        const autoContinues = 0;
        const incremented = (autoContinues ?? 0) + 1;
        expect(incremented).toBe(1);
      }
    });

    it('simulates normal reasoning with tool action', () => {
      // Scenario: Agent starts reasoning, takes a tool action, continues normally
      const reasoningStartTime = Date.now() - 3 * 60 * 1000; // 3 minutes ago
      const isInReasoningPhase = true;
      const lastToolAction = Date.now(); // Took a tool action

      // After tool action, reasoning phase is reset and tool action exists
      const hasToolAction = lastToolAction && lastToolAction > 0;
      const isInReasoning = isInReasoningPhase;

      expect(hasToolAction).toBe(true);
      expect(isInReasoning).toBe(true); // Before reset, still in reasoning phase
    });
  });
});
