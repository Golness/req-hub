/**
 * Meta data validation module.
 * Handles validation and normalization of .meta.json files.
 * @module meta
 */

/**
 * @typedef {Object} MetaData
 * @property {string} type - Requirement type (large/medium/small/unknown)
 * @property {string} summary - One-line summary
 * @property {string[]} features - List of features
 * @property {string[]} fields - List of database fields
 * @property {string[]} tags - List of tags
 * @property {TimelineEvent[]} timeline - List of timeline events
 */

/**
 * @typedef {Object} TimelineEvent
 * @property {string} date - Event date (YYYY-MM-DD)
 * @property {string} title - Event title
 * @property {string} type - Event type (requirement/design/cr/release/other)
 * @property {string} description - Event description
 */

/** Default values for meta data fields */
const META_DEFAULTS = {
  type: 'unknown',
  summary: '',
  features: [],
  fields: [],
  tags: [],
  timeline: [],
};

/**
 * Validate and normalize meta data.
 * Ensures all required fields exist with proper types.
 * @param {Object} meta - Raw meta data object
 * @returns {MetaData} Validated and normalized meta data
 */
export function validateMeta(meta) {
  const result = { ...META_DEFAULTS };
  if (!meta || typeof meta !== 'object') return result;

  if (typeof meta.type === 'string') result.type = meta.type;
  if (typeof meta.summary === 'string') result.summary = meta.summary;
  if (Array.isArray(meta.features)) result.features = meta.features.filter(f => typeof f === 'string');
  if (Array.isArray(meta.fields)) result.fields = meta.fields.filter(f => typeof f === 'string');
  if (Array.isArray(meta.tags)) result.tags = meta.tags.filter(t => typeof t === 'string');
  if (Array.isArray(meta.timeline)) {
    result.timeline = meta.timeline
      .filter(t => t && typeof t === 'object')
      .map(t => ({
        date: typeof t.date === 'string' ? t.date : '',
        title: typeof t.title === 'string' ? t.title : '',
        type: typeof t.type === 'string' ? t.type : 'other',
        description: typeof t.description === 'string' ? t.description : '',
      }));
  }
  return result;
}
