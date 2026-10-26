const pad = value => String(value).padStart(2, '0');

// Keep raw data in the result snapshot; translate API notation at export time.
export function formatVideoDuration(value) {
  if (typeof value !== 'string') return value;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(part => part !== undefined) ||
      (value.includes('T') && !match.slice(2).some(part => part !== undefined))) return value;
  const seconds = Math.floor(Number(match[1] || 0) * 86400 + Number(match[2] || 0) * 3600 +
    Number(match[3] || 0) * 60 + Number(match[4] || 0));
  if (!Number.isSafeInteger(seconds) || seconds < 0) return value;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${pad(minutes)}:${pad(seconds % 60)}`;
}

export function collectionPlatform(results = [], meta = {}) {
  if (['Instagram', 'YouTube', 'Instagram+YouTube'].includes(meta['采集平台'])) return meta['采集平台'];
  const platforms = new Set(results.map(row => row.platform));
  if (platforms.has('instagram') && platforms.has('youtube')) return 'Instagram+YouTube';
  if (platforms.has('instagram')) return 'Instagram';
  if (platforms.has('youtube') || meta['采集模式']) return 'YouTube';
  return '社媒';
}

export function exportFileTag(date = new Date(), platform = '') {
  if (!Number.isFinite(date.getTime())) throw new Error('导出时间无效');
  const label = ['Instagram', 'YouTube', 'Instagram+YouTube', '社媒'].includes(platform) ? `${platform}-` : '';
  return `社媒采集-${label}${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}时${pad(date.getMinutes())}分${pad(date.getSeconds())}秒`;
}
