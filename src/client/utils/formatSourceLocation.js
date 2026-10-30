'use strict';
const { t } = require('../locale.js');

/**
 * Format recorded source locations without altering their identity.
 * @param source - Recorded document source and its page, sheet or line locations.
 * @returns The localized source-location label.
 */
function formatSourceLocation(source) {
  if (source.conversation) {
    const numbers = source.locations?.length
      ? source.locations.map((item) => item.turnNumber)
      : source.conversation.turns.map((turn) => turn.number);
    return t('conversationImport.location', { turns: numbers.join('、') });
  }
  if (source.locations?.length) {
    const labels = source.locations.slice(0, 3).map((location) => {
      if (location.page) {
        return t('formatSourceLocation.message001', { value0: location.page });
      } else if (location.sheet) {
        return t('formatSourceLocation.message002', {
          value0: location.sheet,
          value1: location.range ? ` ${location.range}` : '',
        });
      } else {
        return t('formatSourceLocation.message003', { value0: location.paragraph });
      }
    });
    return (
      labels.join('；') +
      (source.locations.length > 3
        ? t('formatSourceLocation.message004', { value0: source.locations.length })
        : '')
    );
  }
  return `${source.coordinate === 'extracted' ? t('formatSourceLocation.message005') : t('formatSourceLocation.message006')} ${source.startLine}–${source.endLine}`;
}
module.exports = { formatSourceLocation };
