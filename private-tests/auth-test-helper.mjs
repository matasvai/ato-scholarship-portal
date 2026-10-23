export function responseCookies(response, old = '') {
  const jar = new Map(old.split(';').map(pair => pair.trim().split(/=(.*)/s)).filter(pair => pair[0]).map(([key, value]) => [key, value]));
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';'), at = pair.indexOf('=');
    const key = pair.slice(0, at), value = pair.slice(at + 1);
    if (value) jar.set(key, value); else jar.delete(key);
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
}
