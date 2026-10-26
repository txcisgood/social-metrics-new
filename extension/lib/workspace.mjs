export function workspaceFor(module) {
  const youtube = module === 'youtube';
  return {module: youtube ? 'youtube' : 'accounts', youtube,
    resultKey: youtube ? 'youtubeLastRun' : 'lastRun',
    bootErrorKey: youtube ? 'metrics.youtubeBootError' : 'metrics.bootError',
    title: youtube ? 'YouTube 视频采集' : '账号主页采集'};
}

// Move only results made by the interim combined YouTube UI. Account-table
// checkpoints keep their original key; never replace an existing video run.
export async function migrateYouTubeResults(storage) {
  const {lastRun, youtubeLastRun} = await storage.get(['lastRun', 'youtubeLastRun']);
  if (!lastRun?.meta?.['采集模式'] || youtubeLastRun) return;
  await storage.set({youtubeLastRun: lastRun});
  await storage.remove('lastRun');
}
