'use strict';
const React = require('react');
const { Button } = require('./Button.js');
const { useDiffReview } = require('./DiffReviewPage.js');
const { t } = require('../../locale.js');
function DiffViewer(props) {
  const review = useDiffReview();
  return React.createElement(React.Fragment, null, review.page || React.createElement(Button, { onClick: () => review.open(props) }, t('review.open')));
}
module.exports = { DiffViewer };
