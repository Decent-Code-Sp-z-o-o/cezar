import { describe, expect, it } from 'vitest'

import type { ApiRun } from '@open-mercato/cezar-api-client'

import {
  autoModelBadgeLabel,
  modelNameFromIdentity,
  servingModelForAuto,
} from './run-engine'

const base = {
  id: 'r1',
  title: 't',
  workflow: 'quick-task',
  task: 'do it',
  status: 'running' as const,
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  archived: false,
  steps: [],
}

function run(extra: Partial<ApiRun> = {}): ApiRun {
  return { ...base, ...extra } as ApiRun
}

describe('modelNameFromIdentity', () => {
  it('strips the provider prefix from a canonical identity', () => {
    expect(modelNameFromIdentity('openai/Qwen3.8-27B')).toBe('Qwen3.8-27B')
    expect(modelNameFromIdentity('anthropic/haiku')).toBe('haiku')
  })

  it('returns the raw string when it is not provider/model', () => {
    expect(modelNameFromIdentity('haiku')).toBe('haiku')
    expect(modelNameFromIdentity(undefined)).toBeUndefined()
  })
})

describe('servingModelForAuto', () => {
  it('prefers the launch pin over identity', () => {
    expect(
      servingModelForAuto(
        run({ resolvedModel: 'sonnet', modelIdentity: 'anthropic/haiku' }),
      ),
    ).toBe('sonnet')
  })

  it('reads the run identity when nothing was pinned', () => {
    expect(servingModelForAuto(run({ modelIdentity: 'openai/Qwen3.8-27B' }))).toBe('Qwen3.8-27B')
  })

  it('falls back to the latest step identity when the run field is still empty', () => {
    expect(
      servingModelForAuto(
        run({
          steps: [
            {
              id: 'task',
              name: 'task',
              kind: 'agent',
              status: 'done',
              iterations: 1,
              tokensUsed: 0,
              modelIdentity: 'anthropic/haiku',
            },
            {
              id: 'continue-1',
              name: 'Continue',
              kind: 'agent',
              status: 'running',
              iterations: 1,
              tokensUsed: 0,
              modelIdentity: 'openai/Qwen3.8-27B',
            },
          ],
        }),
      ),
    ).toBe('Qwen3.8-27B')
  })
})

describe('autoModelBadgeLabel', () => {
  it('keeps a pinned model unchanged', () => {
    expect(autoModelBadgeLabel('opus', 'haiku')).toBe('opus')
  })

  it('names the serving model beside auto when the ask was auto', () => {
    expect(autoModelBadgeLabel(undefined, 'Qwen3.8-27B')).toBe('auto - Qwen3.8-27B')
  })

  it('stays bare auto until something is known to be serving', () => {
    expect(autoModelBadgeLabel(undefined, undefined)).toBe('auto')
    expect(autoModelBadgeLabel(undefined, 'auto')).toBe('auto')
  })
})
