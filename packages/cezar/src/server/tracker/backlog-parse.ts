import { createHash } from 'node:crypto';

/** One GFM checkbox item inside an epic file — a backlog task. */
export interface ParsedTask {
  /** `<epic-stem>-<hash8>`; stable under edits elsewhere in the file, disambiguated per duplicate. */
  id: string;
  title: string;
  done: boolean;
  /** 1-based line number in the file, as parsed. */
  line: number;
  /** Nearest heading (any level) above the checkbox, text without the hashes. */
  section: string;
}

export interface ParsedEpic {
  stem: string;
  /** First `# ` heading; the file stem when the file has none. */
  title: string;
  tasks: ParsedTask[];
}

/**
 * A task is a GFM task-list item and nothing else: `- [ ]` / `- [x]` / `- [X]`, bulleted or
 * ordered, at any indent. The real corpora these files come from are full of Markdown *links*
 * (`- [EPIC-006 …](./EPIC-006….md)`) — requiring whitespace after the closing bracket is what
 * keeps those from being read as tasks, because a link's `]` is immediately followed by `(`.
 */
const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;

function taskId(stem: string, title: string): string {
  const hash = createHash('sha256').update(title.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 8);
  return `${stem}-${hash}`;
}

/** Parse one epic file's text into its title and checkbox tasks, in file order. */
export function parseEpicMarkdown(stem: string, text: string): ParsedEpic {
  const lines = text.split(/\r?\n/);
  let title = stem;
  let section = '';
  const seen = new Map<string, number>();
  const tasks: ParsedTask[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const heading = HEADING.exec(line);
    if (heading) {
      section = heading[2]!;
      if (heading[1] === '#' && title === stem) title = section;
      continue;
    }
    const task = TASK_LINE.exec(line);
    if (!task) continue;
    const text = task[3]!.trim();
    if (!text) continue;
    const base = taskId(stem, text);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    tasks.push({
      id: occurrence === 1 ? base : `${base}-${occurrence}`,
      title: text,
      done: task[2] !== ' ',
      line: index + 1,
      section,
    });
  }
  return { stem, title, tasks };
}

/**
 * Tick the checkbox on one 1-based line: `[ ]` becomes `[x]`, byte-for-byte everything else on
 * the line is preserved. Returns the new text, or null when the line is not an open checkbox —
 * callers treat that as "already done" or "the file changed underneath us".
 */
export function flipTaskLine(text: string, line: number): string | null {
  if (!Number.isInteger(line) || line < 1) return null;
  // Split AFTER each newline so every line keeps its own terminator: a CRLF file must stay
  // CRLF, and only the one bracket pair may change.
  const lines = text.split(/(?<=\n)/);
  const target = lines[line - 1];
  if (target === undefined) return null;
  const flipped = target.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[ \]/, '$1[x]');
  if (flipped === target) return null;
  lines[line - 1] = flipped;
  return lines.join('');
}
