export function joinDatabricksUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return path.replace(/^\/*/, '');
  if (!path) return baseUrl.replace(/\/+$/, '');

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/*/, '');
  const baseParts = cleanBase.split('/');
  const pathParts = cleanPath.split('/');

  if (baseParts.length > 0 && pathParts.length > 0 && baseParts[baseParts.length - 1] === pathParts[0]) {
    pathParts.shift();
  }

  return cleanBase + '/' + pathParts.join('/');
}
