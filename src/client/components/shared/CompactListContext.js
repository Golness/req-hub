'use strict';
const React = require('react');
// List disclosures open outside the bounded rows so details never displace the pager.
const CompactListContext = React.createContext(false);
module.exports = { CompactListContext };
