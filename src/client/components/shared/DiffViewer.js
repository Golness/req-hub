'use strict';
const React = require('react');
const { Button } = require('./Button.js');
const { useDiffReview } = require('./DiffReviewPage.js');
const { t } = require('../../locale.js');
/**
 * Render a read-only comparison of document versions.
 * @param props - Data, state and callbacks supplied by the owning surface.
 * @returns The rendered component content.
 */
function DiffViewer(props) {
  const review = useDiffReview();
  return React.createElement(
    React.Fragment,
    null,
    review.page ||
      React.createElement(Button, { onClick: () => review.open(props) }, t('review.open')),
  );
}
module.exports = { DiffViewer };
