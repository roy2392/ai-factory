export interface Node {
  id: string;
  depends_on: string[];
}

export function findCycle(tasks: readonly Node[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set<string>();
  const path: string[] = [];
  function visit(id: string): string[] | null {
    const at = path.indexOf(id);
    if (at >= 0) return [...path.slice(at), id];
    if (done.has(id) || !byId.has(id)) return null;
    path.push(id);
    for (const dep of byId.get(id)!.depends_on) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    done.add(id);
    return null;
  }
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

export function topoSort<T extends Node>(tasks: readonly T[]): T[] {
  const cycle = findCycle(tasks);
  if (cycle) throw new Error(`Dependency cycle: ${cycle.join(' -> ')}`);
  const remaining = [...tasks];
  const result: T[] = [];
  while (remaining.length) {
    const index = remaining.findIndex(
      (t) => !t.depends_on.some((id) => remaining.some((n) => n.id === id)),
    );
    result.push(remaining.splice(index, 1)[0]!);
  }
  return result;
}
