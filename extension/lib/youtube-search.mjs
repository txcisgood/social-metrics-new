export const KEYWORD_FILTERS = {
  all: {label: '全部视频', help: '按关键词相关度返回视频，不限制发布日期。', parameters: {order: 'relevance'}},
  recent: {label: '最近上传', help: '按发布时间从新到旧返回视频，不限制发布日期。', parameters: {order: 'date'}},
  live: {label: '直播', help: '搜索正在直播的视频，不限制发布日期。', parameters: {order: 'relevance', eventType: 'live'}},
};

export function keywordFilter(value = 'all') {
  if (!Object.hasOwn(KEYWORD_FILTERS, value)) throw Object.assign(new Error('请选择有效的关键词筛选标签'), {code: 'YT_INPUT'});
  return KEYWORD_FILTERS[value];
}
