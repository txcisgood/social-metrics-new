const VIDEO = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const badURL = message => Object.assign(new Error(message), {code: 'YT_INPUT'});

export function youtubeURL(value) {
  try {
    const text = String(value || '').trim();
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!['https:', 'http:'].includes(url.protocol) || !HOSTS.has(url.hostname) || url.username || url.password || url.port) throw new Error();
    url.protocol = 'https:';
    return url;
  } catch { throw badURL('请填写有效的 YouTube 视频或频道链接。'); }
}

export function parseYouTubeVideoURL(value) {
  const url = youtubeURL(value), parts = url.pathname.split('/').filter(Boolean);
  const id = url.hostname === 'youtu.be' && parts.length === 1 ? parts[0]
    : parts.length === 1 && parts[0] === 'watch' ? url.searchParams.get('v')
      : parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0]) ? parts[1] : '';
  if (!VIDEO.test(id || '')) throw badURL('请填写具体视频链接，频道或播放列表链接请使用频道采集模式。');
  return {id, url: `https://www.youtube.com/watch?v=${id}`};
}

export function parseVideoInputs(lines) {
  const accounts = [], warnings = [], seen = new Set();
  for (const [index, line] of String(lines || '').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const video = parseYouTubeVideoURL(line);
      if (seen.has(video.id)) { warnings.push(`第 ${index + 1} 行视频重复，已去重。`); continue; }
      seen.add(video.id);
      accounts.push({row_no: index + 1, name: video.id, url: video.url, platform: 'youtube', youtubeMode: 'videos', note: ''});
    } catch (error) { warnings.push(`第 ${index + 1} 行：${error.message}`); }
  }
  return {accounts, warnings};
}

export function channelInput(value) {
  const url = youtubeURL(value);
  if (url.hostname === 'youtu.be' || !/^\/(?:@[A-Za-z0-9_.\-%]+|channel\/UC[A-Za-z0-9_-]{22}|user\/[^/]+)(?:\/(?:videos|featured|shorts|streams|about))?\/?$/.test(url.pathname)) {
    throw badURL('请填写频道的 /@用户名、/channel/UC… 或 /user/用户名 主页链接。');
  }
  return url.href;
}
