import { expect, it } from 'vitest'

import { withoutCoveredAssistantPrefix } from './coverage'
import type { ChatMessage } from './types'

it('keeps unknown suffixes local and never equates conflicting durable tool occurrences', () => {
  const stored: ChatMessage = {
    id: 'stored-2-assistant',
    role: 'assistant',
    rowId: 102,
    displayOrder: 2,
    serverRows: [{ rowId: 102, displayOrder: 2 }],
    serverRowSpan: 1,
    parts: [
      { type: 'text', text: 'Checking.', sourceRowId: 102, sourceDisplayOrder: 2 },
      {
        type: 'tool-call',
        toolCallId: 'call',
        toolName: 'read_file',
        args: {},
        sourceRowId: 102,
        sourceDisplayOrder: 2
      }
    ]
  }

  const local: ChatMessage = {
    ...stored,
    rowId: 2,
    serverRows: [{ rowId: 2, displayOrder: 2 }],
    parts: [...stored.parts, { type: 'text', text: 'Uncommitted result' }]
  }

  const [suffix] = withoutCoveredAssistantPrefix([stored], [local])
  expect(suffix.parts).toEqual([{ type: 'text', text: 'Uncommitted result' }])
  expect(suffix.id).not.toBe(stored.id)
  expect(suffix.rowId).toBeUndefined()
  expect(suffix.serverRows).toBeUndefined()
  expect(suffix.serverRowSpan).toBeUndefined()
  expect(suffix.durableComplete).toBe(false)
  expect(withoutCoveredAssistantPrefix([stored], [suffix])).toEqual([suffix])

  const distinct: ChatMessage[] = [
    {
      ...local,
      displayOrder: 12,
      rowId: 12,
      parts: local.parts.map(part => ({ ...part, sourceRowId: 12, sourceDisplayOrder: 12 }))
    }
  ]

  expect(withoutCoveredAssistantPrefix([stored], distinct)).toBe(distinct)
})
