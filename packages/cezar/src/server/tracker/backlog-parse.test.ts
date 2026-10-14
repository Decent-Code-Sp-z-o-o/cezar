import { describe, expect, it } from 'vitest';
import { flipTaskLine, parseEpicMarkdown } from './backlog-parse.ts';

describe('backlog epic parser', () => {
  // The real corpora these files come from are full of Markdown links of the exact shape
  // `- [EPIC-006 …](./EPIC-006….md)`. A parser that reads any `- [ … ]` as a task would
  // hallucinate hundreds of items — this guard pins the discrimination first.
  it('reads GFM checkboxes as tasks and never Markdown links', () => {
    const epic = parseEpicMarkdown('EPIC-076', [
      '# EPIC-076: UX Redesign',
      '',
      '- [EPIC-006 Upload dokumentów i storage](./EPIC-006-upload-dokumentow-i-storage.md)',
      '- [ ] Fundament: `FormField`, `SelectField`',
      '- [x] Wizardy (9) + `KsefImportSection`',
      '- [X] Uppercase tick still counts',
      '  - [ ] nested unchecked',
      '1. [ ] ordered unchecked',
      '2. [x] ordered checked',
      '* [ ] star bullet',
      '- [ ](not-a-task) — bracket followed directly by a paren is a link, not a checkbox',
      '- [ ]',
      '- [] empty brackets are not a checkbox',
    ].join('\n'));
    expect(epic.title).toBe('EPIC-076: UX Redesign');
    expect(epic.tasks.map(task => [task.title, task.done, task.line])).toEqual([
      ['Fundament: `FormField`, `SelectField`', false, 4],
      ['Wizardy (9) + `KsefImportSection`', true, 5],
      ['Uppercase tick still counts', true, 6],
      ['nested unchecked', false, 7],
      ['ordered unchecked', false, 8],
      ['ordered checked', true, 9],
      ['star bullet', false, 10],
    ]);
    expect(epic.tasks.every(task => task.id.startsWith('EPIC-076-'))).toBe(true);
  });

  it('falls back to the file stem when there is no H1 and records the nearest heading', () => {
    const epic = parseEpicMarkdown('EPIC-015-kadry-i-place', [
      '## Kryteria akceptacji',
      '',
      '- Lista płac wymaga zatwierdzenia.',
      '- [ ] Dane płacowe mają podwyższone wymagania dostępu.',
    ].join('\n'));
    expect(epic.title).toBe('EPIC-015-kadry-i-place');
    expect(epic.tasks).toHaveLength(1);
    expect(epic.tasks[0]).toMatchObject({ section: 'Kryteria akceptacji', done: false });
  });

  it('disambiguates duplicate task text with a stable occurrence suffix', () => {
    const epic = parseEpicMarkdown('E', '- [ ] repeat\n- [ ] repeat\n- other\n- [ ] repeat'.trim());
    expect(epic.tasks.map(task => task.id)).toHaveLength(3);
    expect(new Set(epic.tasks.map(task => task.id)).size).toBe(3);
    expect(epic.tasks[0]!.id).toBe(epic.tasks[1]!.id.replace(/-\d+$/, ''));
  });

  it('keeps ids stable when unrelated lines change above a task', () => {
    const before = parseEpicMarkdown('E', '# T\n\n## A\n\n- [ ] the task\n');
    const after = parseEpicMarkdown('E', '# Renamed\n\n## A\n\nnew prose line\n\n- [ ] the task\n');
    expect(after.tasks[0]!.id).toBe(before.tasks[0]!.id);
  });

  describe('flipTaskLine', () => {
    it('ticks exactly the one line, preserving indentation, bullet and line endings', () => {
      const crlf = '# T\r\n\r\n  - [ ] first\r\n- [x] second\r\n';
      expect(flipTaskLine(crlf, 3)).toBe('# T\r\n\r\n  - [x] first\r\n- [x] second\r\n');
      expect(flipTaskLine('1. [ ] ordered\n', 1)).toBe('1. [x] ordered\n');
      expect(flipTaskLine('- [ ] last line without newline', 1)).toBe('- [x] last line without newline');
    });

    it('refuses anything that is not an open checkbox', () => {
      expect(flipTaskLine('- [x] already done\n', 1)).toBeNull();
      expect(flipTaskLine('- plain prose\n', 1)).toBeNull();
      expect(flipTaskLine('- [EPIC-006](./EPIC-006.md)\n', 1)).toBeNull();
      expect(flipTaskLine('- [ ]\n', 1)).toBeNull();
      expect(flipTaskLine('- [ ] only\n', 9)).toBeNull();
      expect(flipTaskLine('- [ ] zero\n', 0)).toBeNull();
    });
  });
});
