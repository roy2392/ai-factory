import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Runs trusted factory code before the model, with no API credentials.
export function stageRequirements(inputDir: string, skillFile: string): void {
  for (const dir of [
    'out',
    '.github',
    '.github/skills',
    '.github/skills/requirements-breakdown',
  ]) {
    if (
      existsSync(dir) &&
      (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink())
    )
      throw new Error(
        'Requirements workspace directories must not be symlinks',
      );
    mkdirSync(dir, { recursive: true });
  }
  for (const name of [
    'requirements.md',
    'existing-tasks.json',
    'mode.txt',
    'prompt.md',
  ]) {
    rmSync(join('out', name), { force: true });
    copyFileSync(join(inputDir, name), join('out', name));
  }
  rmSync('out/issues.json', { force: true });
  const destination = '.github/skills/requirements-breakdown/SKILL.md';
  rmSync(destination, { force: true });
  copyFileSync(skillFile, destination);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [inputDir, skillFile] = process.argv.slice(2);
  if (!inputDir || !skillFile)
    throw new Error('Input directory and trusted skill are required');
  stageRequirements(inputDir, skillFile);
}
