export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp']);
export const PDF_EXTENSIONS = new Set(['pdf']);

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['js', 'javascript'], ['jsx', 'javascript'], ['ts', 'typescript'], ['tsx', 'typescript'],
  ['json', 'json'], ['ipynb', 'json'], ['md', 'markdown'], ['py', 'python'], ['rb', 'ruby'],
  ['go', 'go'], ['rs', 'rust'], ['cpp', 'cpp'], ['c', 'c'], ['h', 'c'], ['hpp', 'cpp'],
  ['java', 'java'], ['cs', 'csharp'], ['php', 'php'], ['html', 'html'], ['css', 'css'],
  ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'], ['xml', 'xml'], ['yaml', 'yaml'],
  ['yml', 'yaml'], ['toml', 'toml'], ['ini', 'ini'], ['sh', 'shell'], ['bash', 'shell'],
  ['zsh', 'shell'], ['fish', 'shell'], ['ps1', 'powershell'], ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'], ['sql', 'sql'], ['graphql', 'graphql'], ['vue', 'vue'],
  ['svelte', 'svelte'],
]);

export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXTENSION.get(ext) ?? 'plaintext';
}
