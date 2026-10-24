'use strict';

function formatSourceLocation(source) {
  if (source.locations?.length) {
    const labels = source.locations.slice(0, 3).map(location => location.page ? `第 ${location.page} 页`
      : location.sheet ? `工作表「${location.sheet}」${location.range ? ` ${location.range}` : ''}`
      : `提取段落 ${location.paragraph}`);
    return labels.join('；') + (source.locations.length > 3 ? ` 等 ${source.locations.length} 处` : '');
  }
  return `${source.coordinate === 'extracted' ? '提取正文行' : '行'} ${source.startLine}–${source.endLine}`;
}
module.exports = { formatSourceLocation };
