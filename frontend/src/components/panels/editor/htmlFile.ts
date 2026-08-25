export function isHtmlFile(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}
