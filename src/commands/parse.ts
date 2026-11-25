export interface AiCommand {
  cmd: 'ask' | 'do' | 'plan' | 'go' | 'stop' | 'help';
  arg: string;
}

export function parseAiCommand(body: string): AiCommand | null {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index < 0) return null;
  const first = lines[index]!.trim();
  if (!/^\/ai(?: |$)/i.test(first)) return null;
  const rest = first.slice(3).trim();
  const [verb = ''] = rest.split(/\s+/);
  const arg = [rest.slice(verb.length).trimStart(), ...lines.slice(index + 1)]
    .join('\n')
    .trim()
    .slice(0, 4000);
  const cmd = verb.toLowerCase();
  if (
    !['ask', 'do', 'plan', 'go', 'stop'].includes(cmd) ||
    ((cmd === 'ask' || cmd === 'do') && !arg)
  )
    return { cmd: 'help', arg };
  return { cmd: cmd as AiCommand['cmd'], arg };
}
